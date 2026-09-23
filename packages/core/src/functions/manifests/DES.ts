// packages/core/src/functions/manifests/DES.ts
//
// DES — Security Description (FUNCTIONS_TIER1.md §DES L107-379, FUNCTIONS.md §6 L1076).
//
// DES is the landing screen of the terminal and the reason `FunctionManifest.variants` exists
// (FUNC-02): eight asset classes, eight entirely different screens, one code. The variant map
// below is what the runner asserts `payload.variant` against at step 7, so a resolver that
// returns the wrong shape for a class fails the run rather than rendering the wrong screen.
//
// Three things about this file are worth stating, because every other Tier 1 manifest copies them:
//
//  1. **`fieldIds(assetClass)` is filtered through the dictionary.** The tier document lists the
//     fields each variant shows; several of those ids do not exist in `core/fields/dictionary.ts`
//     (there is no `PE_RATIO`, `SHORT_INT` or `EE_NEXT_REPORT_DT`, and the dictionary spells the
//     ticker `ID_TICKER` and the composite FIGI `ID_BB_GLOBAL`). The entitlement pre-check resolves
//     every id through `field_licence`, whose rows are *derived from the dictionary*
//     (`server/providers/licences.ts#buildFieldLicenceRows`), so an id the dictionary does not
//     carry for that asset class is denied `FIELD_UNKNOWN` — an audit row that says nothing. The
//     lists below are therefore intersected with the dictionary at module load: what the manifest
//     claims is exactly what can be checked.
//  2. **`tab` is a param, not screen state.** Every tab switch is one `fn.param` usage row
//     (FUNC-04) and the resolver ignores it: the payload carries every block regardless, so the
//     re-run is served from the plant and the request transaction (§DES L131).
//  3. **The CSV is long format** (`section,key,value,unit,asOf,source`), because eight variants
//     cannot share a wide table. See {@link desCsvRows} for the one deviation this file records.

import { z } from 'zod';

import { fromEpochDay } from '../../calendars/calendar.js';
import { getField } from '../../fields/dictionary.js';
import type { FieldId } from '../../types/fields.js';
import type { AssetClass } from '../../types/instrument.js';
import type { ValueCell } from '../../types/function.js';
import type { NewsRow } from '../shared/news.js';
import {
  defineFunction,
  type CsvColumn,
  type CsvDocument,
  type KeyBinding,
  type LiveSpec,
} from '../manifest.js';
// `FnInstrumentSummary` is API.md §3's `InstrumentSummary` declared in core (core may not import
// the SDK). GP.ts owns the declaration and says so in its header; GIP, HP and DES import it.
import type { FnInstrumentSummary } from './GP.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§DES L119-129)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const DesTabs = [
  'profile',
  'identifiers',
  'listings',
  'filings',
  'news',
  'members',
  'terms',
  'history',
] as const;

export const DesParams = z.object({
  tab: z.enum(DesTabs).default('profile'),
  filingsLimit: z.number().int().min(3).max(20).default(8),
  newsLimit: z.number().int().min(3).max(20).default(6),
});
export type DesParams = z.infer<typeof DesParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§DES L133-224)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DesIssuerBlock {
  issuerId: number;
  name: string;
  legalName: string | null;
  cik: string | null;
  lei: string | null;
  sicCode: string | null;
  sicDescription: string | null;
  gicsSector: string | null;
  gicsIndustryGroup: string | null;
  gicsSubIndustry: string | null;
  countryOfIncorp: string | null;
  stateOfInc: string | null;
  /** `'MMDD'`. */
  fiscalYearEnd: string | null;
  filerCategory: string | null;
  entityType: 'operating' | 'fund' | 'sovereign' | 'index_provider' | 'central_bank' | 'other';
  formerNames: { name: string; from: string; to: string | null }[];
  website: string | null;
  provIdx: number;
}

/** Every member is a plant cell with `live` (§0.4 rule 1). */
export interface DesQuoteBlock {
  px: ValueCell;
  chgNet: ValueCell;
  chgPct: ValueCell;
  open: ValueCell;
  high: ValueCell;
  low: ValueCell;
  prevClose: ValueCell;
  volume: ValueCell;
  bid: ValueCell;
  ask: ValueCell;
  bidSize: ValueCell;
  askSize: ValueCell;
  lastTradeTime: ValueCell;
  ivol30d: ValueCell;
  sessionState: ValueCell;
}

/** Bars-derived, `st:'closed'` (§0.4 rules 3-4). */
export interface DesStatsBlock {
  high52w: ValueCell;
  low52w: ValueCell;
  avgVolume30d: ValueCell;
  vol30d: ValueCell;
  ret1d: ValueCell;
  ret1w: ValueCell;
  ret1m: ValueCell;
  retYtd: ValueCell;
  ret1y: ValueCell;
  beta1y: ValueCell;
  /** Last session date used. */
  barsAsOf: string | null;
}

export interface DesEquityFundamentals {
  sharesOut: ValueCell;
  sharesOutAsOf: string | null;
  publicFloat: ValueCell;
  mktCap: ValueCell;
  epsTtmDil: ValueCell;
  peTtm: ValueCell;
  revenueTtm: ValueCell;
  netIncomeTtm: ValueCell;
  dvdSh12m: ValueCell;
  dvdYield: ValueCell;
  lastDividend: {
    exDate: string;
    payDate: string | null;
    amount: number;
    currency: string;
    status: string;
    provIdx: number;
  } | null;
  nextEarnings: {
    expectedDate: string;
    window: [string, string];
    method: 'cadence' | 'prior_year';
    estimated: true;
  } | null;
  shortInterest: {
    settlementDate: string;
    shortQty: number;
    daysToCover: number | null;
    changePct: number | null;
    provIdx: number;
  } | null;
  statementsAsOf: { periodEnd: string; filedAt: string; accessionNo: string } | null;
}

export interface DesFilingRow {
  accessionNo: string;
  form: string;
  filedDate: string;
  reportDate: string | null;
  acceptedAt: string | null;
  items: string[];
  primaryDocDesc: string | null;
  url: string;
  isXbrl: boolean;
  provIdx: number;
}

export interface DesMembershipRow {
  indexCode: string;
  indexInstrumentId: number;
  indexKey: string;
  weight: number | null;
  shares: number | null;
  asOfDate: string;
  sourceId: string;
  provIdx: number;
}

export interface DesIdentifierRow {
  scheme: string;
  value: string;
  qualifier: string;
  isPrimary: boolean;
  validFrom: string;
}

export interface DesListingRow {
  listingId: number;
  figi: string | null;
  mic: string | null;
  exchCode: string;
  localTicker: string;
  isPrimary: boolean;
  listingStatus: string;
  mdLines: {
    mdLineId: number;
    sourceId: string;
    providerSymbol: string;
    lineKind: string;
    intrinsicDelayMin: number;
  }[];
}

export interface DesCalendarBlock {
  calendarId: string;
  tz: string;
}

export interface DesEquityPayload {
  variant: 'equity';
  instrument: FnInstrumentSummary;
  issuer: DesIssuerBlock;
  /** Non-null for `etf` only. */
  fund: {
    fundType: string;
    trackedIndex: { instrumentId: number; key: string } | null;
    sponsor: string | null;
    expenseRatio: number | null;
    inceptionDate: string | null;
    holdingsAsOf: string | null;
    holdingsCount: number | null;
    provIdx: number;
  } | null;
  quote: DesQuoteBlock;
  stats: DesStatsBlock;
  fundamentals: DesEquityFundamentals;
  membership: DesMembershipRow[];
  filings: DesFilingRow[];
  news: NewsRow[];
  identifiers: DesIdentifierRow[];
  listings: DesListingRow[];
  calendar: DesCalendarBlock;
}

export interface DesIndexPayload {
  variant: 'index';
  instrument: FnInstrumentSummary;
  terms: {
    provider: string;
    methodology: string;
    calcCurrency: string;
    region: string | null;
    baseDate: string | null;
    baseValue: number | null;
    constituentCount: number | null;
    proxyFund: { instrumentId: number; key: string } | null;
    membershipSourceId: string | null;
    provIdx: number;
  };
  quote: Pick<
    DesQuoteBlock,
    'px' | 'chgNet' | 'chgPct' | 'open' | 'high' | 'low' | 'prevClose' | 'ivol30d' | 'sessionState'
  >;
  stats: DesStatsBlock;
  membership: {
    asOfDate: string;
    count: number;
    sourceId: string;
    top10: { instrumentId: number; key: string; name: string; weight: number }[];
    sectorWeights: { sector: string; weight: number; count: number }[];
    provIdx: number;
  } | null;
  related: { key: string; label: string }[];
  calendar: DesCalendarBlock;
}

export interface DesFxPayload {
  variant: 'fx';
  instrument: FnInstrumentSummary;
  terms: {
    baseCcy: string;
    quoteCcy: string;
    spotLag: number;
    calendarId: string;
    pipSize: number;
    quoteConvention: 'quote_per_base' | 'base_per_quote';
    provIdx: number;
  };
  quote: Pick<
    DesQuoteBlock,
    'px' | 'chgNet' | 'chgPct' | 'open' | 'high' | 'low' | 'prevClose' | 'sessionState'
  >;
  /** `1 / px`, derived, same `provIdx` as `px`. */
  inverse: ValueCell;
  stats: DesStatsBlock;
  ecb: {
    rateDate: string;
    baseCcyPerUsd: number | null;
    quoteCcyPerUsd: number | null;
    crossRate: number | null;
    provIdx: number;
  } | null;
  calendar: DesCalendarBlock;
}

export interface DesGovtPayload {
  variant: 'govt';
  instrument: FnInstrumentSummary;
  terms: {
    cusip: string;
    securityType: 'bill' | 'note' | 'bond' | 'tips' | 'frn';
    termLabel: string | null;
    issueDate: string | null;
    datedDate: string | null;
    maturityDate: string;
    couponType: string;
    couponRate: number | null;
    couponFreq: number;
    dayCount: string;
    firstCouponDate: string | null;
    businessDayConv: string;
    calendarId: string;
    settlementDays: number;
    minDenomination: number;
    amountOutstanding: number | null;
    onTheRun: boolean;
    issuer: string;
    provIdx: number;
  };
  /** `null` when matured. */
  pricing: {
    settlementDate: string;
    daysToMaturity: number;
    yieldSource: 'bill_quote' | 'par_interp';
    curveId: 'UST_BILL' | 'UST_PAR';
    curveDate: string;
    yield: ValueCell;
    discountRate: ValueCell;
    price: ValueCell;
    accrued: ValueCell;
    dirtyPrice: ValueCell;
    macDuration: ValueCell;
    modDuration: ValueCell;
    convexity: ValueCell;
    dv01: ValueCell;
    provIdx: number;
  } | null;
  identifiers: DesIdentifierRow[];
  calendar: DesCalendarBlock;
}

export interface DesOptionPayload {
  variant: 'option';
  instrument: FnInstrumentSummary;
  terms: {
    occSymbol: string;
    root: string;
    underlying: { instrumentId: number; key: string; name: string };
    expiry: string;
    strike: number;
    putCall: 'C' | 'P';
    exerciseStyle: string;
    settlement: string;
    amPm: string;
    multiplier: number;
    isWeekly: boolean;
    lastTradeDate: string | null;
    daysToExpiry: number;
    provIdx: number;
  };
  quote: {
    bid: ValueCell;
    ask: ValueCell;
    last: ValueCell;
    lastTradeTime: ValueCell;
    volume: ValueCell;
    oi: ValueCell;
    prevClose: ValueCell;
    chgNet: ValueCell;
    chgPct: ValueCell;
    iv: ValueCell;
    delta: ValueCell;
    gamma: ValueCell;
    vega: ValueCell;
    theta: ValueCell;
    rho: ValueCell;
    theo: ValueCell;
  };
  underlying: { px: ValueCell; chgPct: ValueCell };
  moneyness: { intrinsic: ValueCell; timeValue: ValueCell; pctFromSpot: ValueCell };
  chain: {
    expiries: string[];
    contractCount: number | null;
    atmIv: ValueCell;
    putCallRatio: ValueCell;
  } | null;
  calendar: DesCalendarBlock;
}

export interface DesCryptoPayload {
  variant: 'crypto';
  instrument: FnInstrumentSummary;
  coingeckoId: string;
  px: ValueCell;
  chg24hPct: ValueCell;
  asOf: string | null;
  source: 'coingecko.simple';
  caveat: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA';
}

export interface DesRatePayload {
  variant: 'rate';
  instrument: FnInstrumentSummary;
  terms: {
    rateCode: string;
    publisher: string;
    dayCount: string;
    publicationTimeEt: string | null;
    tenorDays: number;
    compounding: string;
    seriesCode: string | null;
    provIdx: number;
  };
  latest: {
    effectiveDate: string;
    rate: ValueCell;
    pct1: ValueCell;
    pct25: ValueCell;
    pct75: ValueCell;
    pct99: ValueCell;
    volumeBn: ValueCell;
    targetFrom: ValueCell;
    targetTo: ValueCell;
    revisionIndicator: string | null;
    vintageAt: string;
  } | null;
  /** The `SOFRAI` row; `null` for every code but `SOFR`. */
  averages: {
    effectiveDate: string;
    avg30d: number | null;
    avg90d: number | null;
    avg180d: number | null;
    indexValue: number | null;
    provIdx: number;
  } | null;
  /**
   * The last 30 fixings, oldest first. Each carries the `provenance` row of the fixing it is
   * (§0.4 rule 3): a published rate is a displayed number and DATA-10 admits no displayed number
   * without one.
   */
  history: { effectiveDate: string; rate: number | null; provIdx: number }[];
  description: string;
}

export interface DesEconPayload {
  variant: 'econ';
  instrument: FnInstrumentSummary;
  series: {
    seriesId: number;
    code: string;
    name: string;
    sourceId: string;
    providerCode: string;
    units: string;
    frequency: 'D' | 'W' | 'M' | 'Q' | 'A';
    seasonalAdj: string | null;
    country: string;
    releaseName: string | null;
    decimals: number;
    firstObsDate: string | null;
    lastObsDate: string | null;
    provIdx: number;
  };
  latest: { obsDate: string; value: ValueCell; status: string; vintageAt: string } | null;
  prior: { obsDate: string; value: number | null; provIdx: number } | null;
  /** Derived from `latest` and `prior`, so it cites its primary input (§0.4 rule 4). */
  change: { abs: number | null; pct: number | null; provIdx: number } | null;
  nextRelease: {
    scheduledAt: string;
    timeKnown: boolean;
    periodLabel: string;
    releaseId: number;
  } | null;
  /**
   * The 24 observations before `latest`, as known at `knownAt`, oldest first. Each cites the
   * `provenance` row of its own vintage — which is the point of a point-in-time series: two
   * observations of the same period can come from two different publications.
   */
  history: { obsDate: string; value: number | null; status: string; provIdx: number }[];
  knownAt: string;
}

export type DesPayload =
  | DesEquityPayload
  | DesIndexPayload
  | DesFxPayload
  | DesGovtPayload
  | DesOptionPayload
  | DesCryptoPayload
  | DesRatePayload
  | DesEconPayload;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fieldIds (§DES L233)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The tier document's list for one class, intersected with the dictionary.
 *
 * A field whose dictionary entry does not name this asset class has no `field_licence` row for the
 * pair and is denied `FIELD_UNKNOWN` by evaluator rule 1 — an audit row that teaches nobody
 * anything and a `meta.entitlement` note that would render a spurious blocked badge on HELP. The
 * intersection is done once, at module load, over the frozen dictionary.
 */
function declared(assetClass: AssetClass, ids: readonly string[]): FieldId[] {
  const out: FieldId[] = [];
  for (const id of ids) {
    const def = getField(id);
    if (def === undefined) continue;
    if (!def.assetClasses.includes(assetClass)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const EQUITY_IDS = [
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'PX_VOLUME',
  'PX_BID',
  'PX_ASK',
  'BID_SIZE',
  'ASK_SIZE',
  'LAST_TRADE_TIME',
  'IVOL_30D',
  'SESSION_STATE',
  'NAME',
  'ID_TICKER',
  'EXCH_CODE',
  'ID_ISIN',
  'ID_CUSIP',
  'ID_BB_GLOBAL',
  'ID_CIK',
  'ID_LEI',
  'CRNCY',
  'SECURITY_TYP',
  'SIC_CODE',
  'GICS_SECTOR_NAME',
  'CNTRY_OF_DOMICILE',
  'FISCAL_YEAR_END',
  'FIRST_TRADE_DT',
  'EQY_SH_OUT',
  'EQY_FLOAT_PCT',
  'CUR_MKT_CAP',
  'IS_EPS_DIL',
  'SALES_REV_TURN',
  'NET_INCOME',
  'DVD_SH_12M',
  'DVD_YIELD',
  'IDX_MEMBER_WEIGHT',
  'PX_HIGH_52W',
  'PX_LOW_52W',
  'VOLUME_AVG_30D',
  'RET_1D',
  'RET_1W',
  'RET_1M',
  'RET_YTD',
  'RET_1Y',
  'VOL_30D',
  'BETA_1Y',
  'HEADLINE',
] as const;

const INDEX_IDS = [
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'IVOL_30D',
  'SESSION_STATE',
  'NAME',
  'ID_TICKER',
  'CRNCY',
  'IDX_MEMBER_WEIGHT',
  'PX_HIGH_52W',
  'PX_LOW_52W',
  'RET_1D',
  'RET_1W',
  'RET_1M',
  'RET_YTD',
  'RET_1Y',
  'VOL_30D',
] as const;

const FX_IDS = [
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'SESSION_STATE',
  'NAME',
  'ID_TICKER',
  'CRNCY',
  'PX_HIGH_52W',
  'PX_LOW_52W',
  'RET_1D',
  'RET_1W',
  'RET_1M',
  'RET_YTD',
  'RET_1Y',
  'VOL_30D',
] as const;

const GOVT_IDS = [
  'NAME',
  'ID_TICKER',
  'ID_CUSIP',
  'SECURITY_TYP',
  'CPN',
  'CPN_FREQ',
  'DAY_CNT',
  'MATURITY',
  'ISSUE_DT',
  'DAYS_TO_MTY',
  'YLD_YTM_MID',
  'DISC_RATE',
  'BEY',
  'PX_DIRTY_MID',
  'PX_CLEAN_MID',
  'ACCRUED',
  'DUR_MID',
  'DUR_ADJ_MID',
  'CONVEXITY_MID',
  'DV01',
  'CURVE_PAR',
] as const;

const OPTION_IDS = [
  'PX_BID',
  'PX_ASK',
  'PX_LAST',
  'LAST_TRADE_TIME',
  'PX_VOLUME',
  'PX_CLOSE_1D',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'OPT_STRIKE_PX',
  'OPT_EXPIRE_DT',
  'OPT_PUT_CALL',
  'OPT_UNDL_TICKER',
  'OPT_CONT_SIZE',
  'OPT_OI',
  'OPT_IV',
  'OPT_DELTA',
  'OPT_GAMMA',
  'OPT_VEGA',
  'OPT_THETA',
  'OPT_RHO',
  'OPT_THEO',
  'OPT_UNDL_PX',
] as const;

const CRYPTO_IDS = ['PX_LAST', 'CHG_PCT_1D', 'LAST_TRADE_TIME', 'NAME', 'ID_TICKER'] as const;

const RATE_IDS = [
  'RATE',
  'RATE_P1',
  'RATE_P25',
  'RATE_P75',
  'RATE_P99',
  'RATE_VOLUME_BN',
  'TARGET_FROM',
  'TARGET_TO',
  'NAME',
  'ID_TICKER',
] as const;

const ECON_IDS = [
  'ECO_VALUE',
  'ECO_PERIOD',
  'ECO_VINTAGE',
  'ECO_PRIOR',
  'ECO_RELEASE_DT',
  'NAME',
  'ID_TICKER',
] as const;

/** Every field the screen shows for a class, intersected with the dictionary — what HELP lists. */
const SCREEN_IDS: Readonly<Partial<Record<AssetClass, FieldId[]>>> = Object.freeze({
  equity: declared('equity', EQUITY_IDS),
  etf: declared('etf', EQUITY_IDS),
  index: declared('index', INDEX_IDS),
  fx: declared('fx', FX_IDS),
  govt: declared('govt', GOVT_IDS),
  option: declared('option', OPTION_IDS),
  crypto: declared('crypto', CRYPTO_IDS),
  rate: declared('rate', RATE_IDS),
  econ: declared('econ', ECON_IDS),
});

/**
 * Every field the screen shows for one asset class (§DES L233), in payload order.
 *
 * This is the *documentation* set — what HELP's field table explains and what a screen's cells
 * are drawn from. It is deliberately **not** the entitlement pre-check set; see {@link FIELD_IDS}.
 */
export function desScreenFieldIds(assetClass: AssetClass | null): FieldId[] {
  return assetClass === null ? [] : [...(SCREEN_IDS[assetClass] ?? [])];
}

/**
 * The entitlement pre-check set: the fields the **plant** serves for this class, and only those.
 *
 * **Why this is narrower than the screen's field list, stated once because every polymorphic
 * screen will hit it.** The runner's step-5 decision does two jobs at once (ARCHITECTURE §10,
 * FUNCTIONS.md §1.4.3): it refuses a caller who may see nothing, and its `effectiveTier` becomes
 * the tier `buildContext` gates the *plant* with. That second job makes the set's composition
 * load-bearing: `effectiveTier` is the **minimum** over the fields asked about, and DES's screen
 * list mixes live quote fields (Cboe, cap `delayed`) with reference and fundamental fields whose
 * sources are capped at `eod` (`sec.submissions`, `finra.shortInterest`, `wiki.sp500`, …). Asking
 * about all of them together therefore drops the decision to `eod`, and `policyTier.view` then
 * freezes **every quote cell on the screen to the official close** — because the screen also
 * shows a SIC code. A user entitled to delayed prices would watch a live security sit still.
 *
 * The honest set for the pre-check is the fields whose *value the plant decides*: the quote block
 * of each variant, which is exactly `manifest.live()`'s field list. `govt` and `econ` read no
 * plant subject at all (`live()` is `null` for `govt`, and `econ` follows an `e:` subject whose
 * values come from `econ_observations`), so their pre-check is empty and every number they show is
 * gated by the data service that reads it.
 *
 * Nothing is thereby un-audited: the reference, fundamental and analytic reads go through
 * `DataServices`, which refuse to be constructed without a decision of their own
 * (`server/test/unit/entitlement.guard.test.ts`), and HELP still explains every screen field
 * through {@link desScreenFieldIds}.
 */
const PLANT_IDS = {
  equity: [
    'PX_LAST',
    'CHG_NET_1D',
    'CHG_PCT_1D',
    'PX_OPEN',
    'PX_HIGH',
    'PX_LOW',
    'PX_CLOSE_1D',
    'PX_VOLUME',
    'PX_BID',
    'PX_ASK',
    'BID_SIZE',
    'ASK_SIZE',
    'LAST_TRADE_TIME',
    'IVOL_30D',
    'SESSION_STATE',
  ],
  index: [
    'PX_LAST',
    'CHG_NET_1D',
    'CHG_PCT_1D',
    'PX_OPEN',
    'PX_HIGH',
    'PX_LOW',
    'PX_CLOSE_1D',
    'IVOL_30D',
    'SESSION_STATE',
  ],
  fx: [
    'PX_LAST',
    'CHG_NET_1D',
    'CHG_PCT_1D',
    'PX_OPEN',
    'PX_HIGH',
    'PX_LOW',
    'PX_CLOSE_1D',
    'SESSION_STATE',
  ],
  // The contract's own terms (`OPT_CONT_SIZE`, `OPT_AM_PM`, …) come from `cboe.symbolBook`,
  // whose licence caps at `eod`; they are read from `option_terms`, not from the plant, so asking
  // about them here would freeze the greeks at the close for the sake of a multiplier.
  option: [
    'PX_BID',
    'PX_ASK',
    'PX_LAST',
    'LAST_TRADE_TIME',
    'PX_VOLUME',
    'PX_CLOSE_1D',
    'CHG_NET_1D',
    'CHG_PCT_1D',
    'OPT_OI',
    'OPT_IV',
    'OPT_DELTA',
    'OPT_GAMMA',
    'OPT_VEGA',
    'OPT_THETA',
    'OPT_RHO',
    'OPT_THEO',
    'OPT_UNDL_PX',
  ],
  crypto: ['PX_LAST', 'CHG_PCT_1D', 'LAST_TRADE_TIME'],
  rate: [
    'RATE',
    'RATE_P1',
    'RATE_P25',
    'RATE_P75',
    'RATE_P99',
    'RATE_VOLUME_BN',
    'TARGET_FROM',
    'TARGET_TO',
  ],
} as const satisfies Partial<Record<AssetClass, readonly string[]>>;

/** Frozen at module load: the pre-check set is a property of the manifest, not of a request. */
const FIELD_IDS: Readonly<Partial<Record<AssetClass, FieldId[]>>> = Object.freeze({
  equity: declared('equity', PLANT_IDS.equity),
  etf: declared('etf', PLANT_IDS.equity),
  index: declared('index', PLANT_IDS.index),
  fx: declared('fx', PLANT_IDS.fx),
  govt: [],
  option: declared('option', PLANT_IDS.option),
  crypto: declared('crypto', PLANT_IDS.crypto),
  rate: declared('rate', PLANT_IDS.rate),
  econ: [],
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§DES L340-344)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const desCsvColumns: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'value', label: 'Value', type: 'string' },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'asOf', label: 'As of', type: 'string' },
  { id: 'source', label: 'Source', type: 'string' },
];

/** `ValueCell` duck-typing — the payload is plain JSON by §1.3 rule 5, so this is all there is. */
function isCell(v: unknown): v is ValueCell {
  return (
    typeof v === 'object' &&
    v !== null &&
    'v' in v &&
    'st' in v &&
    'provIdx' in v &&
    typeof (v as { provIdx: unknown }).provIdx === 'number'
  );
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * `ValueCell.ts` is epoch ms (§1.3 rule 3); a block date is already ISO.
 *
 * Formatted by arithmetic rather than by `Date`: core carries no ambient clock and no `Date`
 * (ARCHITECTURE L49), and a CSV cell's instant is a pure function of the number beside it.
 */
function tsOf(cell: ValueCell): string {
  const ts = cell.ts;
  if (ts === null || ts === undefined) return '';
  const day = Math.floor(ts / 86_400_000);
  const msOfDay = ts - day * 86_400_000;
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  const hh = Math.floor(msOfDay / 3_600_000);
  const mm = Math.floor((msOfDay % 3_600_000) / 60_000);
  const ss = Math.floor((msOfDay % 60_000) / 1_000);
  const mil = msOfDay % 1_000;
  return `${fromEpochDay(day)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(mil, 3)}Z`;
}

/**
 * The long-format rows, one per leaf, in payload order (§1.6 rule 3).
 *
 * **Deviation, recorded rather than hidden.** §DES L342 defines the `source` column as
 * `meta.provenance[provIdx].sourceId`, and `CsvSpec.rows(payload, params)` is handed the payload
 * only — `toCsv` does not pass `meta` (core/functions/csv.ts `CsvContext` carries `display`,
 * `asOf` and `attribution`). The column is therefore filled where the *payload itself* names a
 * source (`crypto.source`, a block's `sourceId`) and left empty otherwise; the export's
 * `# source:` and `# provenance:` header lines carry the full attribution and the cited ids, so
 * nothing about the provenance of an exported number is lost — only its per-row repetition.
 * Filling it properly needs `meta` in `CsvSpec.rows`, which is a WP-08 signature change.
 */
export function desCsvRows(payload: DesPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  const push = (
    section: string,
    key: string,
    value: unknown,
    unit = '',
    asOf = '',
    source = '',
  ): void => {
    rows.push([section, key, scalar(value), unit, asOf, source]);
  };
  const cell = (section: string, key: string, c: ValueCell, unit: string, source = ''): void => {
    push(section, key, c.v, unit, tsOf(c), source);
  };

  const block = (section: string, value: unknown, prefix = '', unit = ''): void => {
    if (value === null || value === undefined) return;
    if (isCell(value)) {
      cell(section, prefix, value, unit);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        block(section, item, `${prefix}[${String(i)}]`, unit);
      });
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        block(section, v, prefix === '' ? k : `${prefix}.${k}`, unit);
      }
      return;
    }
    push(section, prefix, value, unit);
  };

  push('instrument', 'display', payload.instrument.display, 'text');
  push('instrument', 'name', payload.instrument.name, 'text');
  push('instrument', 'assetClass', payload.instrument.assetClass, 'text');
  push('instrument', 'currency', payload.instrument.currency, 'ccy');
  push('instrument', 'variant', payload.variant, 'text');

  switch (payload.variant) {
    case 'equity':
      block('issuer', payload.issuer);
      block('quote', payload.quote, '', 'price');
      block('stats', payload.stats, '', 'pct');
      block('fundamentals', payload.fundamentals);
      block('membership', payload.membership);
      block('filings', payload.filings);
      block('news', payload.news);
      block('identifiers', payload.identifiers);
      block('listings', payload.listings);
      if (payload.fund !== null) block('terms', payload.fund);
      break;
    case 'index':
      block('terms', payload.terms);
      block('quote', payload.quote, '', 'price');
      block('stats', payload.stats, '', 'pct');
      block('membership', payload.membership);
      break;
    case 'fx':
      block('terms', payload.terms);
      block('quote', payload.quote, '', 'price');
      block('quote', payload.inverse, 'inverse', 'price');
      block('stats', payload.stats, '', 'pct');
      block('ecb', payload.ecb);
      break;
    case 'govt':
      block('terms', payload.terms);
      block('pricing', payload.pricing);
      block('identifiers', payload.identifiers);
      break;
    case 'option':
      block('terms', payload.terms);
      block('quote', payload.quote, '', 'price');
      block('moneyness', payload.moneyness, '', 'price');
      block('chain', payload.chain);
      break;
    case 'crypto':
      block('quote', payload.px, 'px', 'price');
      block('quote', payload.chg24hPct, 'chg24hPct', 'pct');
      push('quote', 'asOf', payload.asOf, 'datetime', payload.asOf ?? '', payload.source);
      push('quote', 'caveat', payload.caveat, 'text', '', payload.source);
      break;
    case 'rate':
      block('terms', payload.terms);
      block('latest', payload.latest, '', 'pct');
      block('averages', payload.averages, '', 'pct');
      block('history', payload.history, '', 'pct');
      break;
    case 'econ':
      block('series', payload.series);
      block('latest', payload.latest);
      block('history', payload.history);
      break;
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keyboard (§DES L316-338)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const TAB_KEYS: KeyBinding[] = DesTabs.map((tab, i) => ({
  key: String(i + 1),
  action: `tab-${String(i + 1)}`,
  when: 'always' as const,
  description: `Open the ${tab} tab`,
}));

const DES_KEYMAP: readonly KeyBinding[] = [
  ...TAB_KEYS,
  { key: 'G', action: 'open-gp', when: 'always', description: 'Price graph (GP)' },
  { key: 'Shift+G', action: 'open-gp-next', when: 'always', description: 'GP in the next panel' },
  { key: 'I', action: 'open-gip', when: 'always', description: 'Intraday graph (GIP)' },
  { key: 'H', action: 'open-hp', when: 'always', description: 'Historical prices (HP)' },
  { key: 'Q', action: 'open-q', when: 'always', description: 'Quote lines (Q)' },
  { key: 'F', action: 'open-fa', when: 'always', description: 'Financial analysis (FA)' },
  { key: 'C', action: 'open-cn', when: 'always', description: 'Company news (CN)' },
  { key: 'A', action: 'open-cacs', when: 'always', description: 'Corporate actions (CACS)' },
  { key: 'M', action: 'open-memb', when: 'always', description: 'Index members (MEMB)' },
  { key: 'O', action: 'open-omon', when: 'always', description: 'Option monitor (OMON)' },
  { key: 'V', action: 'open-ovml', when: 'always', description: 'Option valuation (OVML)' },
  { key: 'Y', action: 'open-yas', when: 'always', description: 'Yield and spread (YAS)' },
  { key: 'E', action: 'open-eco', when: 'always', description: 'Economic release (ECO) / FED' },
  { key: 'Enter', action: 'open-filing', when: 'grid', description: 'Open the SEC filing' },
  { key: 'Ctrl+W', action: 'add-watchlist', when: 'always', description: 'Add to a watchlist' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const DES = defineFunction<typeof DesParams, DesPayload>({
  code: 'DES',
  name: 'Security Description',
  aliases: ['DESC'],
  tier: 1,
  category: 'reference',
  // FUNCTIONS.md §6 L1076, verbatim: the tier files may neither narrow nor widen this.
  assetClasses: ['equity', 'etf', 'index', 'fx', 'govt', 'option', 'crypto', 'rate', 'econ'],
  requiresSecurity: true,
  variants: {
    equity: 'equity',
    etf: 'equity',
    index: 'index',
    fx: 'fx',
    govt: 'govt',
    option: 'option',
    crypto: 'crypto',
    rate: 'rate',
    econ: 'econ',
  },
  params: DesParams,
  paramGrammar: {
    positional: [{ name: 'tab', type: 'enum', values: DesTabs, optional: true }],
    keyed: {
      FILINGS: { name: 'filingsLimit', type: 'int' },
      NEWS: { name: 'newsLimit', type: 'int' },
    },
  },
  fieldIds: (assetClass): FieldId[] =>
    assetClass === null ? [] : [...(FIELD_IDS[assetClass] ?? [])],
  pageable: false,
  live: (_params, payload): LiveSpec | null => {
    const id = String(payload.instrument.instrumentId);
    switch (payload.variant) {
      case 'equity':
        return {
          subjects: [`q:${id}`],
          fields: [
            'PX_LAST',
            'CHG_NET_1D',
            'CHG_PCT_1D',
            'PX_OPEN',
            'PX_HIGH',
            'PX_LOW',
            'PX_CLOSE_1D',
            'PX_VOLUME',
            'PX_BID',
            'PX_ASK',
            'BID_SIZE',
            'ASK_SIZE',
            'LAST_TRADE_TIME',
            'IVOL_30D',
            'SESSION_STATE',
          ],
          conflationMs: 250,
        };
      case 'index':
        return {
          subjects: [`q:${id}`],
          fields: [
            'PX_LAST',
            'CHG_NET_1D',
            'CHG_PCT_1D',
            'PX_OPEN',
            'PX_HIGH',
            'PX_LOW',
            'PX_CLOSE_1D',
            'IVOL_30D',
            'SESSION_STATE',
          ],
          conflationMs: 250,
        };
      case 'fx':
        return {
          subjects: [`q:${id}`],
          fields: [
            'PX_LAST',
            'CHG_NET_1D',
            'CHG_PCT_1D',
            'PX_OPEN',
            'PX_HIGH',
            'PX_LOW',
            'PX_CLOSE_1D',
            'SESSION_STATE',
          ],
          conflationMs: 250,
        };
      case 'option': {
        const undl = String(payload.terms.underlying.instrumentId);
        return {
          subjects: [`q:${id}`, `q:${undl}`, `oc:${undl}`],
          fields: [
            'PX_BID',
            'PX_ASK',
            'PX_LAST',
            'LAST_TRADE_TIME',
            'PX_VOLUME',
            'PX_CLOSE_1D',
            'CHG_NET_1D',
            'CHG_PCT_1D',
            'OPT_OI',
            'OPT_IV',
            'OPT_DELTA',
            'OPT_GAMMA',
            'OPT_VEGA',
            'OPT_THETA',
            'OPT_RHO',
            'OPT_THEO',
            'EXPIRIES',
            'ATM_IV',
            'PUT_CALL_RATIO',
            'CONTRACT_COUNT',
          ],
          conflationMs: 500,
          essential: [`q:${id}`, `q:${undl}`],
        };
      }
      case 'crypto':
        return {
          subjects: [`q:${id}`],
          fields: ['PX_LAST', 'CHG_PCT_1D', 'LAST_TRADE_TIME'],
          conflationMs: 1000,
        };
      case 'rate':
        return {
          subjects: [`q:${id}`],
          fields: [
            'RATE',
            'RATE_P1',
            'RATE_P25',
            'RATE_P75',
            'RATE_P99',
            'RATE_VOLUME_BN',
            'TARGET_FROM',
            'TARGET_TO',
          ],
          conflationMs: 5000,
        };
      case 'econ':
        return { subjects: [`e:${payload.series.code}`], fields: '*', conflationMs: 5000 };
      case 'govt':
        return null;
    }
  },
  csv: {
    filename: (_params, ctx): string =>
      `DES_${(ctx.display ?? 'SECURITY').replace(/[^A-Za-z0-9]+/g, '_')}_` +
      `${ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.csv`,
    columns: desCsvColumns,
    rows: (payload): CsvDocument['rows'] => desCsvRows(payload),
  },
  help: {
    summary: 'Security description: profile, identifiers, quote, terms, membership, filings, news',
    description:
      'DES is the landing screen for any security. It shows who issued it, how it is identified ' +
      '(FIGI, ISIN, CUSIP, CIK, LEI), the live composite quote with its source and staleness, ' +
      'one-year statistics, point-in-time fundamentals from SEC XBRL (as known at the knownAt ' +
      'shown in the footer), index membership, the latest filings and headlines. The screen ' +
      'differs by asset class: equities and ETFs show issuer and fundamentals, indices show ' +
      'methodology and top constituents, FX shows conventions and the ECB reference rate, ' +
      'Treasuries show full terms and curve-implied pricing (settlement T+1, ACT/360 discount ' +
      'for bills, street convention for notes), options show contract terms with Cboe-published ' +
      'greeks, rates show the latest fixing with percentiles, economic series show the latest ' +
      'observation and the next release. Numbers marked with a dash are unavailable for the ' +
      'reason shown; nothing is estimated.',
    params: [
      { name: 'tab', text: 'Which lower block is open', example: 'FILINGS' },
      { name: 'filingsLimit', text: 'Filings shown, 3-20', example: 'FILINGS=12' },
      { name: 'newsLimit', text: 'Headlines shown, 3-20', example: 'NEWS=10' },
    ],
    keys: DES_KEYMAP.map((k) => ({ key: k.key, action: k.description })),
    sources: [
      'cboe.quotes',
      'yahoo.chart',
      'openfigi.mapping',
      'sec.tickers',
      'sec.submissions',
      'sec.companyfacts',
      'sec.archives',
      'ssga.holdings',
      'wiki.sp500',
      'finra.shortInterest',
      'bbg.rss',
      'sec.atom',
      'treasury.yieldcurve',
      'treasury.bills',
      'nyfed.rates',
      'fred.csv',
      'bls.timeseries',
      'frankfurter',
      'coingecko.simple',
      'cboe.options',
      'internal.derived',
    ],
    related: ['GP', 'GIP', 'HP', 'Q', 'FA', 'CN', 'CACS', 'MEMB', 'OMON', 'YAS', 'ECO'],
  },
  keymap: DES_KEYMAP,
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default DES;
