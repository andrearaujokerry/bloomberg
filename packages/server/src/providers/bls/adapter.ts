/**
 * `bls.timeseries` and `bls.schedule` — the impure half. PROVIDERS.b §10.5, §10.6, §2.2.
 *
 * Two `ProviderId`s, one family, one bucket — and that bucket is the whole design constraint: the
 * keyless v2 tier allows **25 queries a day**, the scheduler may take 70 % of it, and the bucket
 * is persisted in `schema_meta` by `providers/http.ts` (`providerDefaults(...).daily`) so a crash
 * loop cannot breach the quota. Consequently:
 *
 *  - {@link fetchBlsTimeseries} takes **every** series id in one call. One query, not one per
 *    series (§10.5); a caller that loops over series is spending the day in a minute.
 *  - `budgetShare` defaults to `'scheduler'` and there is no interactive path: ECO and the `e:`
 *    subjects read `econ_observations`, so a user pressing `GO` cannot spend the day's quota.
 *
 * `Content-Type: application/json` is the per-provider default in `providers/http.ts`;
 * `BLS_API_KEY` is declared on the licence row but unused in v1, and a key would be added there,
 * not here, because `config.ts` is the only reader of the environment.
 */

import type { HttpClient, ProviderAdapter, RawRecord } from '../types.js';
import type { BlsScheduleExpectation, BlsScheduleRows, BlsTimeseriesRows } from './parse.js';
import { normaliseBlsSchedule, normaliseBlsTimeseries } from './parse.js';

/** §10.5. Note the trailing slash: without it the API answers `404` on some edges. */
export const BLS_TIMESERIES_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';

/** §10.6 — `{month}{yy}.htm`, e.g. `september26.htm`. */
export const BLS_SCHEDULE_BASE_URL = 'https://www.bls.gov/schedule/news_release/';

/** One `adapter_version` for the family (§1.4). */
export const BLS_ADAPTER_VERSION = 'bls/1.0.0';

/** §10.6: the calendar is re-read every 6 hours at most. */
export const BLS_SCHEDULE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** §10.5: 25 series ids per query on the keyless tier. */
export const BLS_MAX_SERIES_PER_QUERY = 25;

/** §10.5: 10 years of history per query on the keyless tier. */
export const BLS_MAX_YEARS_PER_QUERY = 10;

const MONTH_SLUGS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

export interface BlsTimeseriesRequest {
  /** Every headline series id, in one array (§10.5). */
  seriesIds: readonly string[];
  startYear: number;
  endYear: number;
  traceId?: string;
  runId?: number;
}

export interface BlsScheduleRequest {
  year: number;
  /** 1-12. */
  month: number;
  traceId?: string;
  runId?: number;
}

/**
 * The exact POST body of §10.5. Series ids are sorted and de-duplicated: the body participates in
 * the request key (§3.2), so an unordered list would miss its recorded capture on every run.
 *
 * The recorded capture's body is `{"seriesid":["CUUR0000SA0"],"startyear":"2024","endyear":"2026"}`
 * — key order and the string-typed years are both what BLS published, and both are reproduced
 * here exactly.
 */
export function blsTimeseriesBody(req: BlsTimeseriesRequest): string {
  const seriesid = [...new Set(req.seriesIds)].sort();
  return JSON.stringify({
    seriesid,
    startyear: String(req.startYear),
    endyear: String(req.endYear),
  });
}

/** `2026-09` → `https://www.bls.gov/schedule/news_release/september26.htm` (§10.6). */
export function blsScheduleUrl(year: number, month: number): string {
  const slug = MONTH_SLUGS[month - 1];
  if (slug === undefined) {
    throw new RangeError(`bls schedule month must be 1-12, got ${String(month)}`);
  }
  const yy = String(year % 100).padStart(2, '0');
  return `${BLS_SCHEDULE_BASE_URL}${slug}${yy}.htm`;
}

/** One POST carrying every series id (§10.5). Never parses, never writes. */
export async function fetchBlsTimeseries(
  http: HttpClient,
  req: BlsTimeseriesRequest,
): Promise<RawRecord> {
  const request: Parameters<HttpClient['post']>[0] = {
    providerId: 'bls.timeseries',
    method: 'POST',
    url: BLS_TIMESERIES_URL,
    body: blsTimeseriesBody(req),
    budgetShare: 'scheduler',
  };
  if (req.traceId !== undefined) request.traceId = req.traceId;
  if (req.runId !== undefined) request.runId = req.runId;
  return http.post(request);
}

/** One month of the release calendar (§10.6). */
export async function fetchBlsSchedule(
  http: HttpClient,
  req: BlsScheduleRequest,
): Promise<RawRecord> {
  const request: Parameters<HttpClient['get']>[0] = {
    providerId: 'bls.schedule',
    url: blsScheduleUrl(req.year, req.month),
    cacheTtlMs: BLS_SCHEDULE_CACHE_TTL_MS,
    budgetShare: 'scheduler',
  };
  if (req.traceId !== undefined) request.traceId = req.traceId;
  if (req.runId !== undefined) request.runId = req.runId;
  return http.get(request);
}

export const blsTimeseriesAdapter: ProviderAdapter<BlsTimeseriesRequest, BlsTimeseriesRows> = {
  id: 'bls.timeseries',
  sourceId: 'bls.timeseries',
  adapterVersion: BLS_ADAPTER_VERSION,
  fetch: fetchBlsTimeseries,
  normalise: normaliseBlsTimeseries,
};

/**
 * The schedule adapter's `normalise` cannot see the month the URL asked for (the contract is
 * `(raw, ctx)`), so the structural assertion of §10.6 runs against the page's own `<title>` here
 * and the caller that knows the month calls {@link normaliseBlsSchedule} with its expectation to
 * get the stronger check.
 */
export const blsScheduleAdapter: ProviderAdapter<BlsScheduleRequest, BlsScheduleRows> = {
  id: 'bls.schedule',
  sourceId: 'bls.schedule',
  adapterVersion: BLS_ADAPTER_VERSION,
  fetch: fetchBlsSchedule,
  normalise: (raw, ctx) => normaliseBlsSchedule(raw, ctx),
};

/** Re-exported so a caller can state the month it asked for. */
export type { BlsScheduleExpectation };
