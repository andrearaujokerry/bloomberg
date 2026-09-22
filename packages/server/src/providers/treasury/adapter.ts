/**
 * `treasury.yieldcurve` and `treasury.bills` — the impure half (PROVIDERS §9.1, §9.2).
 *
 * Both adapters build a URL and hand it to `HttpClient`; neither parses a byte and neither writes
 * a row. The two endpoints differ only in the `data=` parameter, and both are answered by the same
 * slow OData service: **a yield-curve response takes ≈ 18 s**, which is why
 *
 *  - the bucket is one request a minute (`providerDefaults('treasury.*')`, PROVIDERS §2.2),
 *  - both adapters are registered `schedulerOnly` (§2.6) — the interactive read-through never
 *    fetches them; a screen shows what `curve_points` holds and how old it is,
 *  - and the default TTL here is six hours rather than the global `0`. Treasury publishes once a
 *    day at ≈ 18:00 ET and `ingest/jobs/treasuryCurves.ts` runs once a day, so a six-hour TTL can
 *    never suppress a scheduled run: it only stops an accidental second fetch from paying 18 s
 *    again. A caller that must bypass it passes `cacheTtlMs: 0`.
 *
 * The month parameter is the caller's, not a clock reading: `field_tdr_date_value_month=YYYYMM`
 * returns that whole month in one response, so the job asks for the current month daily and for a
 * back-month once when it back-fills.
 */

import type {
  HttpClient,
  Normalised,
  NormaliseContext,
  ProviderAdapter,
  RawRecord,
} from '../types.js';
import type { ProviderRegistry } from '../registry.js';
import { TREASURY_ADAPTER_VERSION, parseBillRates, parseYieldCurve } from './parse.js';
import type { TreasuryBillRows, TreasuryYieldCurveRows } from './parse.js';

/** The one endpoint both datasets are served from. */
export const TREASURY_XML_URL =
  'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml';

/** `data=` for the par yield curve. */
export const YIELD_CURVE_DATASET = 'daily_treasury_yield_curve';
/** `data=` for the bill rates. */
export const BILL_RATES_DATASET = 'daily_treasury_bill_rates';

/** Six hours — see the note above; never long enough to skip a daily 18:00 ET run. */
export const TREASURY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** What either adapter needs to build its URL. */
export interface TreasuryRequest {
  /** `'202609'`. The feed returns the whole month in one response. */
  month: string;
  /** Override the six-hour default; `0` forces a revalidation. */
  cacheTtlMs?: number;
  traceId?: string;
  runId?: number;
}

const MONTH_RE = /^\d{6}$/;

/** `https://…/xml?data=<dataset>&field_tdr_date_value_month=<YYYYMM>`. */
export function treasuryUrl(dataset: string, month: string): string {
  if (!MONTH_RE.test(month)) {
    throw new Error(
      `treasuryUrl: month must be 'YYYYMM', got '${month}' — the Treasury feed answers an ` +
        'unparsable month with an empty feed rather than an error, so this is checked here',
    );
  }
  return `${TREASURY_XML_URL}?data=${dataset}&field_tdr_date_value_month=${month}`;
}

/** `'202609'` for September 2026 — the month of an ISO date, for a caller that holds one. */
export function monthOfIsoDate(date: string): string {
  return `${date.slice(0, 4)}${date.slice(5, 7)}`;
}

function fetchDataset(
  http: HttpClient,
  providerId: 'treasury.yieldcurve' | 'treasury.bills',
  dataset: string,
  req: TreasuryRequest,
): Promise<RawRecord> {
  return http.get({
    providerId,
    url: treasuryUrl(dataset, req.month),
    // The service serves `application/atom+xml`; the header is stated rather than assumed
    // because the same path serves HTML to a browser Accept.
    headers: { accept: 'application/xml' },
    cacheTtlMs: req.cacheTtlMs ?? TREASURY_CACHE_TTL_MS,
    ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
    ...(req.runId === undefined ? {} : { runId: req.runId }),
    budgetShare: 'scheduler',
  });
}

/** `treasury.yieldcurve` — `curve_points(curve_id 'UST_PAR')`. Scheduler-only. */
export const treasuryYieldCurveAdapter: ProviderAdapter<TreasuryRequest, TreasuryYieldCurveRows> = {
  id: 'treasury.yieldcurve',
  sourceId: 'treasury.yieldcurve',
  adapterVersion: TREASURY_ADAPTER_VERSION,
  fetch(http: HttpClient, req: TreasuryRequest): Promise<RawRecord> {
    return fetchDataset(http, 'treasury.yieldcurve', YIELD_CURVE_DATASET, req);
  },
  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<TreasuryYieldCurveRows> {
    return parseYieldCurve(raw, ctx);
  },
};

/** `treasury.bills` — `curve_points(curve_id 'UST_BILL')`, `govt_terms`, the bill master. */
export const treasuryBillsAdapter: ProviderAdapter<TreasuryRequest, TreasuryBillRows> = {
  id: 'treasury.bills',
  sourceId: 'treasury.bills',
  adapterVersion: TREASURY_ADAPTER_VERSION,
  fetch(http: HttpClient, req: TreasuryRequest): Promise<RawRecord> {
    return fetchDataset(http, 'treasury.bills', BILL_RATES_DATASET, req);
  },
  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<TreasuryBillRows> {
    return parseBillRates(raw, ctx);
  },
};

/**
 * Register both, scheduler-only. Called from the startup composition root (ARCHITECTURE §12.1);
 * `register` itself checks the licence row and the `adapter_version` shape.
 */
export function registerTreasuryAdapters(registry: ProviderRegistry): ProviderRegistry {
  registry.register(treasuryYieldCurveAdapter, { schedulerOnly: true });
  registry.register(treasuryBillsAdapter, { schedulerOnly: true });
  return registry;
}
