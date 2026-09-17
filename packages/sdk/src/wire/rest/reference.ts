/**
 * `wire/rest/reference.ts` — `Rest.Reference.*`: the 11 resolution and reference routes.
 *
 * Routes and schemas transcribed from API.md §5.1 L399-436. The `Bitemporal`-extending row
 * shapes (`Instrument`, `Issue`, `Issuer`, `Listing`, `MdLine`) are ARCHITECTURE §4.1 L427-472
 * serialised camelCase, as API.md L405 requires.
 * Owned by WP-01 now, by WP-08 (`server/src/http/routes/reference.ts`) afterwards.
 *
 * Route descriptor shape: { method, path, params?, query?, body?, response, status, format? }
 * (`path` relative to `/api/v1`; `:name` placeholders match `params`).
 */
import { z } from 'zod';

import { AssetClass, InstrumentSummary, MarketSector, SecurityRefInput } from '../common.js';
import { AsOf, Meta, ProvenanceRef } from '../envelope.js';

/**
 * A repeated (`?status=a&status=b`) or comma-separated (`?status=a,b`) query list.
 * Both forms reach the server; the SDK sends the array form.
 */
const listQuery = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v: unknown) => (typeof v === 'string' ? v.split(',').filter((s) => s.length > 0) : v),
    z.array(item),
  );

/* ------------------------------------------------------- common row shapes */

/** ARCHITECTURE §4.1 L428-430: every reference row is a version; ranges are half-open. */
export const Bitemporal = z.object({
  versionId: z.number().int(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
  txFrom: z.iso.datetime(),
  txTo: z.iso.datetime(),
  provenanceId: z.number().int(),
});
export type Bitemporal = z.infer<typeof Bitemporal>;

export const Issuer = Bitemporal.extend({
  issuerId: z.number().int(),
  name: z.string(),
  legalName: z.string().optional(),
  lei: z.string().optional(),
  cik: z.string().optional(),
  country: z.string().optional(),
  sic: z.string().optional(),
  entityType: z.enum(['operating', 'fund', 'sovereign', 'index_provider', 'central_bank', 'other']),
  /** 'MMDD' from SEC submissions.fiscalYearEnd */
  fiscalYearEnd: z.string().optional(),
});
export type Issuer = z.infer<typeof Issuer>;

export const Issue = Bitemporal.extend({
  issueId: z.number().int(),
  issuerId: z.number().int(),
  assetClass: AssetClass,
  /** OpenFIGI securityType: 'Common Stock','ETP','REIT','Index','Spot','US GOVERNMENT',… */
  securityType: z.string(),
  shareClassFigi: z.string().optional(),
  isin: z.string().optional(),
  cusip: z.string().optional(),
  sedol: z.string().optional(),
  name: z.string(),
  currency: z.string().length(3),
  countryOfIssue: z.string().optional(),
});
export type Issue = z.infer<typeof Issue>;

export const Instrument = Bitemporal.extend({
  instrumentId: z.number().int(),
  issueId: z.number().int(),
  assetClass: AssetClass,
  marketSector: MarketSector,
  compositeFigi: z.string().optional(),
  ticker: z.string(),
  /** OpenFIGI composite code 'US'; 'GOVT','FX','INDEX' for non-listed */
  exchCode: z.string(),
  name: z.string(),
  currency: z.string().length(3),
  primaryListingId: z.number().int().optional(),
  status: z.enum(['active', 'delisted', 'pending', 'matured', 'expired']),
  /** autocomplete prior (index members > 1) */
  searchWeight: z.number(),
});
export type Instrument = z.infer<typeof Instrument>;

export const Listing = Bitemporal.extend({
  listingId: z.number().int(),
  instrumentId: z.number().int(),
  figi: z.string().optional(),
  mic: z.string().optional(),
  exchCode: z.string(),
  localTicker: z.string(),
  isPrimary: z.boolean(),
  listingStatus: z.enum(['active', 'suspended', 'delisted']),
});
export type Listing = z.infer<typeof Listing>;

export const MdLine = Bitemporal.extend({
  mdLineId: z.number().int(),
  instrumentId: z.number().int(),
  /** undefined = composite line */
  listingId: z.number().int().optional(),
  /** `licence_registry.source_id`: 'cboe.quotes','yahoo.chart','nyfed.rates',… */
  sourceId: z.string(),
  providerSymbol: z.string(),
  lineKind: z.enum(['composite', 'venue', 'derived', 'reference']),
  intrinsicDelayMin: z.number().int(),
  expectedIntervalMs: z.number().int(),
  /** lower wins ties in composite merge */
  priority: z.number().int(),
});
export type MdLine = z.infer<typeof MdLine>;

/* ------------------------------------------------------------------- terms
 * API.md L405: `terms` is `GovtTerms | OptionTerms | FutureTerms | FundTerms | IndexTerms |
 * FxTerms | RateTerms` discriminated by `kind`. Columns are DATA_MODEL's `*_terms` tables
 * serialised camelCase; `catchall(unknown)` carries the long tail (schedules, covenants,
 * per-asset-class extras) without rejecting a response.
 */

const TermsBase = {
  instrumentId: z.number().int(),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().optional(),
  provIdx: z.number().int().optional(),
};

export const GovtTerms = z
  .object({
    ...TermsBase,
    kind: z.literal('govt'),
    securityType: z.enum(['bill', 'note', 'bond', 'tips', 'frn']),
    cusip: z.string().nullable(),
    /** '4WK','13WK','2Y','10Y','30Y' */
    termLabel: z.string().nullable(),
    issueDate: z.iso.date().nullable(),
    datedDate: z.iso.date().nullable(),
    maturityDate: z.iso.date(),
    couponType: z.enum(['fixed', 'zero', 'float', 'step', 'inflation_linked']),
    /** percent; null for bills */
    couponRate: z.number().nullable(),
    couponFreq: z.number().int().nullable(),
    dayCount: z.enum(['ACT/ACT', 'ACT/360', 'ACT/365F', '30/360', '30E/360', 'ACT/ACT-ISDA']),
    firstCouponDate: z.iso.date().nullable(),
    lastRegularCoupon: z.iso.date().nullable(),
    businessDayConv: z.enum(['following', 'modified_following', 'preceding', 'none']),
    calendarId: z.string().nullable(),
    settlementDays: z.number().int().nullable(),
    /** 'SOFR' for FRNs */
    referenceIndex: z.string().nullable(),
    spreadBp: z.number().nullable(),
    /** TIPS */
    indexRatioBase: z.number().nullable(),
    isCallable: z.boolean(),
    minDenomination: z.number().nullable(),
    increment: z.number().nullable(),
    amountOutstanding: z.number().nullable(),
    onTheRun: z.boolean().nullable(),
  })
  .catchall(z.unknown());
export type GovtTerms = z.infer<typeof GovtTerms>;

export const OptionTerms = z
  .object({
    ...TermsBase,
    kind: z.literal('option'),
    /** 'AAPL260916C00245000' as Cboe publishes it (root unpadded) */
    occSymbol: z.string().nullable(),
    root: z.string(),
    underlyingInstrumentId: z.number().int().nullable(),
    expiry: z.iso.date(),
    strike: z.number(),
    putCall: z.enum(['C', 'P']),
    exerciseStyle: z.enum(['american', 'european']),
    settlement: z.enum(['physical', 'cash']),
    amPmSettlement: z.enum(['am', 'pm']),
    multiplier: z.number().int(),
    tickSize: z.number().nullable(),
    exerciseCutoffLocal: z.string().nullable(),
    isWeekly: z.boolean(),
    lastTradeDate: z.iso.date().nullable(),
  })
  .catchall(z.unknown());
export type OptionTerms = z.infer<typeof OptionTerms>;

export const FutureTerms = z
  .object({
    ...TermsBase,
    kind: z.literal('future'),
    root: z.string(),
    underlyingInstrumentId: z.number().int().nullable(),
    exchangeMic: z.string().nullable(),
    expiry: z.iso.date(),
    lastTradeDate: z.iso.date().nullable(),
    firstNoticeDate: z.iso.date().nullable(),
    firstDeliveryDate: z.iso.date().nullable(),
    multiplier: z.number(),
    tickSize: z.number(),
    tickValue: z.number(),
    settlement: z.enum(['physical', 'cash']),
    deliveryMonths: z.array(z.string()),
  })
  .catchall(z.unknown());
export type FutureTerms = z.infer<typeof FutureTerms>;

export const FundTerms = z
  .object({
    ...TermsBase,
    kind: z.literal('fund'),
    fundKind: z.string().nullable(),
    expenseRatio: z.number().nullable(),
    inceptionDate: z.iso.date().nullable(),
    benchmarkInstrumentId: z.number().int().nullable(),
    distributionFreq: z.string().nullable(),
  })
  .catchall(z.unknown());
export type FundTerms = z.infer<typeof FundTerms>;

export const IndexTerms = z
  .object({
    ...TermsBase,
    kind: z.literal('index'),
    indexFamily: z.string().nullable(),
    weighting: z.string().nullable(),
    rebalanceFreq: z.string().nullable(),
    baseDate: z.iso.date().nullable(),
    baseValue: z.number().nullable(),
  })
  .catchall(z.unknown());
export type IndexTerms = z.infer<typeof IndexTerms>;

export const FxTerms = z
  .object({
    ...TermsBase,
    kind: z.literal('fx'),
    baseCurrency: z.string().length(3),
    quoteCurrency: z.string().length(3),
    settlementDays: z.number().int().nullable(),
    quoteConvention: z.string().nullable(),
  })
  .catchall(z.unknown());
export type FxTerms = z.infer<typeof FxTerms>;

export const RateTerms = z
  .object({
    ...TermsBase,
    kind: z.literal('rate'),
    rateCode: z.string(),
    dayCount: z.string().nullable(),
    publicationLagDays: z.number().int().nullable(),
    administrator: z.string().nullable(),
  })
  .catchall(z.unknown());
export type RateTerms = z.infer<typeof RateTerms>;

export const Terms = z.discriminatedUnion('kind', [
  GovtTerms,
  OptionTerms,
  FutureTerms,
  FundTerms,
  IndexTerms,
  FxTerms,
  RateTerms,
]);
export type Terms = z.infer<typeof Terms>;

/* ----------------------------------------------- §5.1 transcribed schemas */

export const ResolveItem = z.object({
  ref: SecurityRefInput,
  instrument: InstrumentSummary.nullable(),
  /** non-empty when ambiguous or not found (best matches, ≤ 8) */
  candidates: z.array(InstrumentSummary),
  error: z
    .object({
      code: z.enum(['SECURITY_NOT_FOUND', 'AMBIGUOUS_SECURITY', 'NOT_IN_UNIVERSE']),
      message: z.string(),
    })
    .optional(),
  /** a miss may be filled from OpenFIGI mapping → master row created (REF-01); Yahoo hits are never auto-added */
  source: z.enum(['master', 'openfigi', 'yahoo']).default('master'),
});
export type ResolveItem = z.infer<typeof ResolveItem>;

export const ResolveResponse = z.object({
  meta: Meta.pick({ traceId: true, asOf: true, servedAt: true }),
  results: z.array(ResolveItem),
});
export type ResolveResponse = z.infer<typeof ResolveResponse>;

export const IdScheme = z.enum([
  'FIGI',
  'COMPOSITE_FIGI',
  'SHARE_CLASS_FIGI',
  'ISIN',
  'CUSIP',
  'SEDOL',
  'RIC',
  'TICKER_EXCH',
  'LEI',
  'MIC',
  'CIK',
  'OCC',
  'PROVIDER_SYMBOL',
  'SERIES_CODE',
]);
export type IdScheme = z.infer<typeof IdScheme>;

export const Identifier = z.object({
  scheme: IdScheme,
  value: z.string(),
  qualifier: z.string(),
  isPrimary: z.boolean(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
});
export type Identifier = z.infer<typeof Identifier>;

export const VersionRow = z.object({
  versionId: z.number().int(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
  txFrom: z.iso.datetime(),
  txTo: z.iso.datetime(),
  provenance: ProvenanceRef,
  data: z.record(z.string(), z.unknown()),
});
export type VersionRow = z.infer<typeof VersionRow>;

export const CorporateActionType = z.enum([
  'cash_dividend',
  'special_dividend',
  'stock_dividend',
  'split',
  'reverse_split',
  'spinoff',
  'merger',
  'tender',
  'rights',
  'call',
  'conversion',
  'name_change',
  'ticker_change',
  'delisting',
  'capital_return',
]);
export type CorporateActionType = z.infer<typeof CorporateActionType>;

export const CorporateActionStatus = z.enum([
  'estimated',
  'announced',
  'confirmed',
  'paid',
  'cancelled',
]);
export type CorporateActionStatus = z.infer<typeof CorporateActionStatus>;

export const CorporateAction = z.object({
  caId: z.number().int(),
  instrumentId: z.number().int(),
  caType: CorporateActionType,
  status: CorporateActionStatus,
  declaredDate: z.iso.date().nullable(),
  exDate: z.iso.date(),
  recordDate: z.iso.date().nullable(),
  payDate: z.iso.date().nullable(),
  effectiveDate: z.iso.date().nullable(),
  amount: z.number().nullable(),
  currency: z.string().length(3).nullable(),
  ratioNew: z.number().nullable(),
  ratioOld: z.number().nullable(),
  newInstrumentId: z.number().int().nullable(),
  frequency: z.string().nullable(),
  grossOrNet: z.enum(['gross', 'net']),
  details: z.record(z.string(), z.unknown()),
  sourceId: z.string(),
  reviewState: z.enum(['auto', 'queued', 'reviewed', 'rejected']),
  provIdx: z.number().int(),
});
export type CorporateAction = z.infer<typeof CorporateAction>;

/** `entity_classifications` joined to `classification_codes` (DATA_MODEL). */
export const Classification = z.object({
  scheme: z.string(),
  code: z.string(),
  name: z.string(),
  parentCode: z.string().nullable(),
  level: z.number().int().nullable(),
});
export type Classification = z.infer<typeof Classification>;

export const Person = z.object({
  personId: z.number().int(),
  name: z.string(),
  /** 'CEO','CFO','Fed Chair','Reporter' */
  role: z.string(),
  issuerId: z.number().int().nullable(),
  userId: z.number().int().nullable(),
  aliases: z.array(z.string()),
  sourceId: z.string(),
});
export type Person = z.infer<typeof Person>;

export const EntityKind = z.enum(['issuer', 'issue', 'instrument', 'listing', 'person', 'topic']);
export type EntityKind = z.infer<typeof EntityKind>;

export const EntityRelation = z.object({
  fromKind: EntityKind,
  fromId: z.number().int(),
  toKind: EntityKind,
  toId: z.number().int(),
  relation: z.enum([
    'parent_of',
    'subsidiary_of',
    'holds',
    'officer_of',
    'director_of',
    'tracks',
    'supplier_of',
    'customer_of',
  ]),
  weight: z.number().nullable(),
  sourceId: z.string(),
});
export type EntityRelation = z.infer<typeof EntityRelation>;

export const InstrumentDetail = z.object({
  meta: Meta,
  instrument: Instrument,
  issue: Issue,
  issuer: Issuer,
  listings: z.array(Listing),
  mdLines: z.array(MdLine),
  terms: Terms.nullable(),
  classifications: z.array(Classification),
  identifiers: z.array(Identifier),
});
export type InstrumentDetail = z.infer<typeof InstrumentDetail>;

export const IdentifiersResponse = z.object({ meta: Meta, identifiers: z.array(Identifier) });
export const VersionsResponse = z.object({ meta: Meta, versions: z.array(VersionRow) });
export const CorporateActionsResponse = z.object({ meta: Meta, actions: z.array(CorporateAction) });
export const TermsResponse = z.object({ meta: Meta, terms: Terms.nullable() });

export const IssuerResponse = z.object({
  meta: Meta,
  issuer: Issuer,
  instruments: z.array(InstrumentSummary),
  people: z.array(Person),
  relations: z.array(EntityRelation),
  aliases: z.array(z.string()),
});
export type IssuerResponse = z.infer<typeof IssuerResponse>;

export const CalendarResponse = z.object({
  calendarId: z.string(),
  holidays: z.array(
    z.object({
      day: z.iso.date(),
      name: z.string(),
      kind: z.enum(['holiday', 'early_close']),
      closeTimeLocal: z.string().optional(),
    }),
  ),
  sessions: z.array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      openLocal: z.string(),
      closeLocal: z.string(),
      preOpenLocal: z.string().optional(),
      postCloseLocal: z.string().optional(),
    }),
  ),
  tz: z.string(),
});
export type CalendarResponse = z.infer<typeof CalendarResponse>;

export const MembersResponse = z.object({
  meta: Meta,
  asOfDate: z.iso.date(),
  members: z.array(
    z.object({
      instrument: InstrumentSummary,
      weight: z.number().nullable(),
      shares: z.number().nullable(),
      marketValue: z.number().nullable(),
      sourceId: z.string(),
    }),
  ),
});
export type MembersResponse = z.infer<typeof MembersResponse>;

export const ClassificationScheme = z.enum(['sic', 'naics', 'gics', 'internal']);
export type ClassificationScheme = z.infer<typeof ClassificationScheme>;

export const ClassificationsResponse = z.object({
  scheme: ClassificationScheme,
  nodes: z.array(
    z.object({ code: z.string(), name: z.string(), parentCode: z.string().nullable() }),
  ),
});
export type ClassificationsResponse = z.infer<typeof ClassificationsResponse>;

export const VersionsTable = z.enum([
  'instruments',
  'issues',
  'issuers',
  'listings',
  'md_lines',
  'identifiers',
  'govt_terms',
  'option_terms',
  'future_terms',
  'index_members',
  'corporate_actions',
]);
export type VersionsTable = z.infer<typeof VersionsTable>;

/** `validAt` / `knownAt` — the as-of pair every reference read accepts (REF-03). */
export const AsOfQuery = z.object({
  validAt: z.iso.datetime().optional(),
  knownAt: z.iso.datetime().optional(),
});
export type AsOfQuery = z.infer<typeof AsOfQuery>;

export const ResolveGetQuery = AsOfQuery.extend({
  ref: z.string().min(1).max(120),
  /** TERM-03 context: prefer the same exchange/sector */
  panelSecurityId: z.coerce.number().int().optional(),
});

export const ResolvePostRequest = z.object({
  refs: z.array(SecurityRefInput).min(1).max(200),
  asOf: AsOf.optional(),
  panelSecurityId: z.number().int().optional(),
});
export type ResolvePostRequest = z.infer<typeof ResolvePostRequest>;

const InstrumentIdParam = z.object({ instrumentId: z.coerce.number().int() });

/* ------------------------------------------------------------------- routes */

/** The 11 routes of API.md §5.1 (`http/routes/reference.ts`). */
export const Reference = {
  /** Single-item resolve from the command line. */
  Resolve: {
    method: 'GET',
    path: '/ref/resolve',
    query: ResolveGetQuery,
    response: ResolveResponse,
    status: 200,
  },
  /** Batch resolve (≤ 200 refs). */
  ResolveMany: {
    method: 'POST',
    path: '/ref/resolve',
    body: ResolvePostRequest,
    response: ResolveResponse,
    status: 200,
  },
  /** The full security master record as-of `validAt`/`knownAt`. */
  Get: {
    method: 'GET',
    path: '/ref/:instrumentId',
    params: InstrumentIdParam,
    query: AsOfQuery,
    response: InstrumentDetail,
    status: 200,
  },
  Identifiers: {
    method: 'GET',
    path: '/ref/:instrumentId/identifiers',
    params: InstrumentIdParam,
    query: AsOfQuery,
    response: IdentifiersResponse,
    status: 200,
  },
  /** The bitemporal audit view (REF-03). */
  Versions: {
    method: 'GET',
    path: '/ref/:instrumentId/versions',
    params: InstrumentIdParam,
    query: z.object({
      table: VersionsTable.default('instruments'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    response: VersionsResponse,
    status: 200,
  },
  /** DATA-08. */
  CorporateActions: {
    method: 'GET',
    path: '/ref/:instrumentId/corporate-actions',
    params: InstrumentIdParam,
    query: AsOfQuery.extend({
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      status: listQuery(CorporateActionStatus).optional(),
    }),
    response: CorporateActionsResponse,
    status: 200,
  },
  /** REF-04 / REF-05. */
  Terms: {
    method: 'GET',
    path: '/ref/:instrumentId/terms',
    params: InstrumentIdParam,
    query: AsOfQuery,
    response: TermsResponse,
    status: 200,
  },
  /** REF-08. */
  Issuer: {
    method: 'GET',
    path: '/issuers/:issuerId',
    params: z.object({ issuerId: z.coerce.number().int() }),
    query: AsOfQuery,
    response: IssuerResponse,
    status: 200,
  },
  /** REF-06; `from`/`to` span at most 5 years. */
  Calendar: {
    method: 'GET',
    path: '/calendars/:calendarId',
    params: z.object({ calendarId: z.string().min(1).max(32) }),
    query: z.object({ from: z.iso.date(), to: z.iso.date() }),
    response: CalendarResponse,
    status: 200,
  },
  /** REF-07, MEMB. */
  Members: {
    method: 'GET',
    path: '/indices/:instrumentId/members',
    params: InstrumentIdParam,
    query: AsOfQuery.extend({
      asOfDate: z.iso.date().optional(),
      source: z.enum(['sec.archives', 'ssga.holdings']).optional(),
    }),
    response: MembersResponse,
    status: 200,
  },
  Classifications: {
    method: 'GET',
    path: '/classifications/:scheme',
    params: z.object({ scheme: ClassificationScheme }),
    query: z.object({ code: z.string().optional() }),
    response: ClassificationsResponse,
    status: 200,
  },
} as const;
