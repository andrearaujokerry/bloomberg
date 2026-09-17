/**
 * `wire/rest/data.ts` — `Rest.Data.*`: the one data endpoint, its convenience GETs and the
 * curve / rate / econ / options / holders reads.
 *
 * Routes transcribed from API.md §5.4 L539-557; `POST /data/csv` is API.md §9 L1188 (its
 * request/response schemas live in `rest/export.ts`, which owns the CSV contract).
 * The `DataRequest` / `DataResponse` model itself is `wire/dataRequest.ts` (API.md §4).
 * Owned by WP-01 now, by WP-08 (`server/src/http/routes/data.ts`) afterwards.
 *
 * Routes covered (16):
 *   POST /data                       GET /data/reference   GET /data/history
 *   GET  /data/intraday              GET /data/ticks       GET /data/snapshot
 *   GET  /curves/:curveId            GET /curves/:curveId/history
 *   GET  /rates/:rateCode            GET /econ/series/:seriesCode
 *   GET  /econ/calendar              GET /econ/fomc
 *   GET  /options/chain              GET /holders/:instrumentId
 *   GET  /short-interest/:instrumentId
 *   POST /data/csv                   (API.md §9)
 *
 * Route descriptor shape: { method, path, params?, query?, body?, response, status, format? }.
 */
import { z } from 'zod';

import {
  AdjustPolicy,
  FieldId,
  FieldValue,
  InstrumentSummary,
  Periodicity,
  Tier,
  ValueState,
} from '../common.js';
import { DataRequest, DataResponse, SeriesBlock } from '../dataRequest.js';
import { EngineNote, Meta } from '../envelope.js';
import { ReasonCode } from '../reasonCodes.js';
import { CsvDocument, DataCsvRequest } from './export.js';
import { OptionTerms } from './reference.js';

/**
 * A repeated (`?fields=a&fields=b`) or comma-separated (`?fields=a,b`) query list.
 * The convenience GETs of §5.4 are documented with the comma form.
 */
const listQuery = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v: unknown) => (typeof v === 'string' ? v.split(',').filter((s) => s.length > 0) : v),
    z.array(item),
  );

/** The command-line form of a security ref, e.g. `AAPL US Equity` or `/isin/US0378331005`. */
const SecurityRefString = z.string().min(1).max(120);

const AsOfQuery = z.object({
  validAt: z.iso.datetime().optional(),
  knownAt: z.iso.datetime().optional(),
});

/* ------------------------------------------- §5.4 convenience GET queries */

export const ReferenceQuery = AsOfQuery.extend({
  securities: listQuery(SecurityRefString),
  fields: listQuery(FieldId),
});

export const HistoryQuery = AsOfQuery.extend({
  security: SecurityRefString,
  fields: listQuery(FieldId).optional(),
  start: z.iso.date(),
  end: z.iso.date().optional(),
  periodicity: Periodicity.optional(),
  adjust: AdjustPolicy.optional(),
  currency: z.string().length(3).optional(),
  fill: z.enum(['none', 'prev']).optional(),
});
export type HistoryQuery = z.infer<typeof HistoryQuery>;

export const IntradayQuery = z.object({
  security: SecurityRefString,
  fields: listQuery(FieldId).optional(),
  start: z.iso.datetime(),
  end: z.iso.datetime().optional(),
  interval: z.enum(['1m', '5m', '15m', '1h']).optional(),
  session: z.enum(['regular', 'extended']).optional(),
});
export type IntradayQuery = z.infer<typeof IntradayQuery>;

export const TicksQuery = z.object({
  security: SecurityRefString,
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  kinds: listQuery(z.enum(['trade', 'quote', 'summary'])).optional(),
  limit: z.coerce.number().int().min(1).max(100000).optional(),
  cursor: z.string().optional(),
});
export type TicksQuery = z.infer<typeof TicksQuery>;

export const SnapshotQuery = z.object({
  securities: listQuery(SecurityRefString),
  fields: listQuery(FieldId),
  tier: Tier.optional(),
});
export type SnapshotQuery = z.infer<typeof SnapshotQuery>;

/* ---------------------------------------------------------------- curves */

export const CurveKind = z.enum(['par', 'bill', 'cmt', 'fixing', 'ois', 'zero']);
export const CurveQuoteType = z.enum([
  'par_yield',
  'discount_rate',
  'investment_yield',
  'cmt_yield',
  'ois_rate',
  'zero_rate',
  'fixing',
]);

export const CurveInfo = z.object({
  /** 'UST_PAR','UST_BILL','UST_CMT','SOFR_FIX','SOFR_OIS' (plant subjects `c:UST_PAR`, …) */
  curveId: z.string(),
  name: z.string(),
  currency: z.string().length(3),
  kind: CurveKind,
  dayCount: z.string(),
  compounding: z.enum(['semiannual', 'annual', 'simple', 'continuous']),
  sourceId: z.string(),
});
export type CurveInfo = z.infer<typeof CurveInfo>;

export const CurvePoint = z.object({
  /** '1M','3M','2Y','10Y','30Y' | '4WK','13WK','52WK' | 'ON' */
  tenor: z.string(),
  tenorDays: z.number().int(),
  quoteType: CurveQuoteType,
  value: z.number().nullable(),
  instrumentId: z.number().int().nullable(),
  maturityDate: z.iso.date().nullable(),
  provIdx: z.number().int(),
});
export type CurvePoint = z.infer<typeof CurvePoint>;

export const CurveBuild = z.object({
  buildId: z.number().int(),
  /** 'bills+par_bootstrap' | 'ois_bootstrap' */
  method: z.string(),
  interpolation: z.string(),
  engine: EngineNote,
  nodes: z.array(z.object({ t: z.number(), df: z.number(), zero: z.number(), fwd: z.number() })),
});
export type CurveBuild = z.infer<typeof CurveBuild>;

export const CurveResponse = z.object({
  meta: Meta,
  curve: CurveInfo,
  curveDate: z.iso.date(),
  points: z.array(CurvePoint),
  build: CurveBuild.optional(),
});
export type CurveResponse = z.infer<typeof CurveResponse>;

export const CurveHistoryResponse = z.object({ meta: Meta, series: SeriesBlock });
export type CurveHistoryResponse = z.infer<typeof CurveHistoryResponse>;

/* ----------------------------------------------------------------- rates */

export const RateFixing = z.object({
  effectiveDate: z.iso.date(),
  vintageAt: z.iso.datetime(),
  /** percentRate (null for SOFRAI) */
  rate: z.number().nullable(),
  pct1: z.number().nullable(),
  pct25: z.number().nullable(),
  pct75: z.number().nullable(),
  pct99: z.number().nullable(),
  volumeBn: z.number().nullable(),
  /** EFFR only */
  targetFrom: z.number().nullable(),
  targetTo: z.number().nullable(),
  avg30d: z.number().nullable(),
  avg90d: z.number().nullable(),
  avg180d: z.number().nullable(),
  indexValue: z.number().nullable(),
  revisionIndicator: z.string().nullable(),
  isLatest: z.boolean(),
  provIdx: z.number().int(),
});
export type RateFixing = z.infer<typeof RateFixing>;

export const RateResponse = z.object({ meta: Meta, fixings: z.array(RateFixing) });
export type RateResponse = z.infer<typeof RateResponse>;

/* ------------------------------------------------------------------ econ */

export const EconSeriesInfo = z.object({
  seriesId: z.number().int(),
  code: z.string(),
  name: z.string(),
  sourceId: z.string(),
  unit: z.string().nullable(),
  frequency: z.string().nullable(),
  seasonalAdj: z.string().nullable(),
});
export type EconSeriesInfo = z.infer<typeof EconSeriesInfo>;

export const EconObservation = z.object({
  obsDate: z.iso.date(),
  value: z.number().nullable(),
  status: z.enum(['final', 'preliminary', 'revised', 'missing']),
  vintageAt: z.iso.datetime(),
  isLatest: z.boolean(),
  provIdx: z.number().int(),
});
export type EconObservation = z.infer<typeof EconObservation>;

export const EconSeriesResponse = z.object({
  meta: Meta,
  series: EconSeriesInfo,
  observations: z.array(EconObservation),
});
export type EconSeriesResponse = z.infer<typeof EconSeriesResponse>;

export const EconEvent = z.object({
  eventId: z.number().int(),
  releaseId: z.number().int(),
  releaseName: z.string(),
  scheduledAt: z.iso.datetime(),
  /** false when only the release day is known */
  timeKnown: z.boolean(),
  periodLabel: z.string(),
  seriesCode: z.string().nullable(),
  actual: z.number().nullable(),
  prior: z.number().nullable(),
  revisedPrior: z.number().nullable(),
  /** always null: no consensus source in v1 (BRIEF §2) */
  consensus: z.null(),
  consensusUnavailableReason: z.enum(['NO_SOURCE', 'NOT_LICENSED', 'NOT_APPLICABLE']),
  status: z.enum(['scheduled', 'released', 'revised', 'cancelled']),
  provIdx: z.number().int(),
});
export type EconEvent = z.infer<typeof EconEvent>;

export const EconCalendarResponse = z.object({ meta: Meta, events: z.array(EconEvent) });
export type EconCalendarResponse = z.infer<typeof EconCalendarResponse>;

export const FomcMeeting = z.object({
  meetingDate: z.iso.date(),
  statementAt: z.iso.datetime().nullable(),
  hasSep: z.boolean(),
  decisionBp: z.number().nullable(),
});
export type FomcMeeting = z.infer<typeof FomcMeeting>;

export const FomcResponse = z.object({ meetings: z.array(FomcMeeting) });
export type FomcResponse = z.infer<typeof FomcResponse>;

/* --------------------------------------------------------------- options */

export const ChainContract = z.object({
  instrument: InstrumentSummary,
  terms: OptionTerms,
  /** the requested `OPT_*`, `PX_BID/ASK`, `OPT_OI` values */
  f: z.record(z.string(), FieldValue),
  r: z.record(z.string(), ReasonCode).optional(),
  st: ValueState,
  ts: z
    .object({
      src: z.iso.datetime().nullable(),
      cap: z.iso.datetime(),
      pub: z.iso.datetime(),
    })
    .optional(),
});
export type ChainContract = z.infer<typeof ChainContract>;

export const ChainResponse = z.object({
  meta: Meta,
  underlying: InstrumentSummary,
  underlyingPx: z.number().nullable(),
  expiries: z.array(z.iso.date()),
  contracts: z.array(ChainContract),
});
export type ChainResponse = z.infer<typeof ChainResponse>;

export const ChainQuery = z.object({
  /** ref (`AAPL US Equity`) or instrumentId */
  underlying: SecurityRefString,
  expiry: z.iso.date().optional(),
  strikeMin: z.coerce.number().optional(),
  strikeMax: z.coerce.number().optional(),
  putCall: z.enum(['C', 'P']).optional(),
});
export type ChainQuery = z.infer<typeof ChainQuery>;

/* --------------------------------------------- holders and short interest */

export const Holder = z.object({
  holderName: z.string(),
  holderKind: z.enum(['etf', '13f']),
  /** the holder's own instrument when it is an ETF we know */
  instrumentId: z.number().int().nullable().optional(),
  shares: z.number().nullable(),
  marketValue: z.number().nullable(),
  weight: z.number().nullable(),
  asOfDate: z.iso.date(),
  sourceId: z.string(),
  provIdx: z.number().int(),
});
export type Holder = z.infer<typeof Holder>;

export const HoldersResponse = z.object({ meta: Meta, holders: z.array(Holder) });
export type HoldersResponse = z.infer<typeof HoldersResponse>;

export const ShortInterestRow = z.object({
  settlementDate: z.iso.date(),
  shortInterest: z.number().nullable(),
  avgDailyVolume: z.number().nullable(),
  daysToCover: z.number().nullable(),
  provIdx: z.number().int(),
});
export type ShortInterestRow = z.infer<typeof ShortInterestRow>;

export const ShortInterestResponse = z.object({ meta: Meta, rows: z.array(ShortInterestRow) });
export type ShortInterestResponse = z.infer<typeof ShortInterestResponse>;

/* ------------------------------------------------------------------- routes */

const InstrumentIdParam = z.object({ instrumentId: z.coerce.number().int() });

/** The 15 routes of API.md §5.4 plus the §9 CSV export (`http/routes/data.ts`). */
export const Data = {
  /** The single data endpoint — all five kinds (API.md §4). */
  Request: {
    method: 'POST',
    path: '/data',
    body: DataRequest,
    response: DataResponse,
    status: 200,
  },
  /** = `kind:'reference'` through the same dispatcher. */
  Reference: {
    method: 'GET',
    path: '/data/reference',
    query: ReferenceQuery,
    response: DataResponse,
    status: 200,
  },
  /** = `kind:'historical'` (single security). */
  History: {
    method: 'GET',
    path: '/data/history',
    query: HistoryQuery,
    response: DataResponse,
    status: 200,
  },
  /** = `kind:'intraday'`. */
  Intraday: {
    method: 'GET',
    path: '/data/intraday',
    query: IntradayQuery,
    response: DataResponse,
    status: 200,
  },
  /** = `kind:'tick'`; paginated with `results[].nextCursor`. */
  Ticks: {
    method: 'GET',
    path: '/data/ticks',
    query: TicksQuery,
    response: DataResponse,
    status: 200,
  },
  /** = `kind:'realtime'` (one-shot plant view). */
  Snapshot: {
    method: 'GET',
    path: '/data/snapshot',
    query: SnapshotQuery,
    response: DataResponse,
    status: 200,
  },
  /** CRVF / ICVS / GC. `build=true` returns the bootstrapped nodes. */
  Curve: {
    method: 'GET',
    path: '/curves/:curveId',
    params: z.object({ curveId: z.string().min(1).max(32) }),
    query: AsOfQuery.extend({
      date: z.iso.date().optional(),
      build: z.stringbool().optional(),
    }),
    response: CurveResponse,
    status: 200,
  },
  /** One tenor through time. */
  CurveHistory: {
    method: 'GET',
    path: '/curves/:curveId/history',
    params: z.object({ curveId: z.string().min(1).max(32) }),
    query: z.object({
      tenor: z.string().min(1).max(8),
      from: z.iso.date(),
      to: z.iso.date(),
      quoteType: CurveQuoteType.optional(),
    }),
    response: CurveHistoryResponse,
    status: 200,
  },
  /** BTMM, FED. `vintages=true` returns every vintage, not just `is_latest`. */
  Rate: {
    method: 'GET',
    path: '/rates/:rateCode',
    params: z.object({ rateCode: z.string().min(1).max(16) }),
    query: z.object({
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      vintages: z.stringbool().optional(),
    }),
    response: RateResponse,
    status: 200,
  },
  /** ECO, GP on econ series; `vintage` honours `knownAt` (STOR-06). */
  EconSeries: {
    method: 'GET',
    path: '/econ/series/:seriesCode',
    params: z.object({ seriesCode: z.string().min(1).max(64) }),
    query: z.object({
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      vintage: z.enum(['latest', 'all', 'asOf']).default('latest'),
      knownAt: z.iso.datetime().optional(),
    }),
    response: EconSeriesResponse,
    status: 200,
  },
  /** ECO calendar; `consensus` is always null with reason `NO_SOURCE` (BRIEF §2). */
  EconCalendar: {
    method: 'GET',
    path: '/econ/calendar',
    query: z.object({
      from: z.iso.date(),
      to: z.iso.date(),
      country: z.string().length(2).optional(),
      releaseId: z.coerce.number().int().optional(),
    }),
    response: EconCalendarResponse,
    status: 200,
  },
  /** WIRP nodes. */
  Fomc: {
    method: 'GET',
    path: '/econ/fomc',
    query: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }),
    response: FomcResponse,
    status: 200,
  },
  /** OMON. */
  OptionChain: {
    method: 'GET',
    path: '/options/chain',
    query: ChainQuery,
    response: ChainResponse,
    status: 200,
  },
  /** HDS: ETF holders from `etf_holdings`; 13F where feasible. */
  Holders: {
    method: 'GET',
    path: '/holders/:instrumentId',
    params: InstrumentIdParam,
    query: z.object({ asOfDate: z.iso.date().optional() }),
    response: HoldersResponse,
    status: 200,
  },
  ShortInterest: {
    method: 'GET',
    path: '/short-interest/:instrumentId',
    params: InstrumentIdParam,
    query: z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }),
    response: ShortInterestResponse,
    status: 200,
  },
  /**
   * API.md §9 L1188: any `DataRequest` kind except `realtime` with > 500 securities.
   * `200 text/csv`; reference → one row per security, historical/intraday → one row per
   * `(security, index)`, tick → one row per tick.
   */
  Csv: {
    method: 'POST',
    path: '/data/csv',
    body: DataCsvRequest,
    response: CsvDocument,
    status: 200,
    format: 'csv',
  },
} as const;
