/**
 * `fred.csv` and `fred.calendar` — the impure half (PROVIDERS §10.1, §10.2).
 *
 * The CSV path is the keyless macro workhorse: `fredgraph.csv?id=DGS10` returns the series' whole
 * history — 262 KB and 16,880 observations back to 1962 for DGS10 — with no API key, where the
 * JSON API needs `FRED_API_KEY`. That is why `cacheTtlMs` is `0` here and the conditional request
 * does the work: `HttpClient` sends `If-None-Match`, and a day on which nothing changed costs a
 * 304 and no parse at all (§2.4).
 *
 * The calendar path is two pages behind one `source_id`, so `fredCalendarAdapter.normalise`
 * dispatches on the record's own URL: `/releases/calendar` is the ECO calendar and `/releases` is
 * the catalogue. Both are HTML with no contract, so both are cached for an hour and both parse
 * fail-closed (§10.2).
 */

import type {
  HttpClient,
  Normalised,
  NormaliseContext,
  ProviderAdapter,
  RawRecord,
} from '../types.js';
import type { ProviderRegistry } from '../registry.js';
import {
  FRED_ADAPTER_VERSION,
  normaliseCalendar,
  parseFredCsv,
  parseReleaseCatalogue,
} from './parse.js';
import type { FredCalendarRows, FredCatalogueRows, FredCsvRows } from './parse.js';

export const FRED_CSV_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
export const FRED_CALENDAR_URL = 'https://fred.stlouisfed.org/releases/calendar';
export const FRED_RELEASES_URL = 'https://fred.stlouisfed.org/releases';

/** One hour — the calendar is re-parsed daily at 05:00 ET (§10.2). */
export const FRED_CALENDAR_CACHE_TTL_MS = 60 * 60 * 1000;

/** `fredgraph.csv?id=DGS10`. */
export function fredCsvUrl(seriesId: string): string {
  const id = seriesId.trim();
  if (id === '' || /[?&#\s]/.test(id)) {
    throw new Error(
      `fredCsvUrl: '${seriesId}' is not a FRED series id — the id becomes a query parameter and ` +
        'a malformed one returns FRED’s HTML error page with status 200',
    );
  }
  return `${FRED_CSV_URL}?id=${encodeURIComponent(id)}`;
}

export interface FredCsvRequest {
  /** `'DGS10'` — `econ_series.provider_code`. */
  seriesId: string;
  traceId?: string;
  runId?: number;
}

/** Which of the two calendar pages to fetch. */
export type FredCalendarPage = 'calendar' | 'catalogue';

export interface FredCalendarRequest {
  page?: FredCalendarPage;
  /** `/releases?pageID=2` — the catalogue is paged 1–7 at 50 rows a page. */
  pageId?: number;
  cacheTtlMs?: number;
  traceId?: string;
  runId?: number;
}

/** The catalogue page URL, `pageID` omitted for page 1 exactly as the site links it. */
export function fredCatalogueUrl(pageId?: number): string {
  if (pageId === undefined || pageId <= 1) return FRED_RELEASES_URL;
  return `${FRED_RELEASES_URL}?pageID=${String(Math.trunc(pageId))}`;
}

/** `fred.csv` — the full history of one series, keyless. */
export const fredCsvAdapter: ProviderAdapter<FredCsvRequest, FredCsvRows> = {
  id: 'fred.csv',
  sourceId: 'fred.csv',
  adapterVersion: FRED_ADAPTER_VERSION,
  fetch(http: HttpClient, req: FredCsvRequest): Promise<RawRecord> {
    return http.get({
      providerId: 'fred.csv',
      url: fredCsvUrl(req.seriesId),
      headers: { accept: 'text/csv' },
      // Always revalidate: the conditional request is what makes a daily poll of a 262 KB file
      // free on the days nothing was published (§10.1).
      cacheTtlMs: 0,
      ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
      ...(req.runId === undefined ? {} : { runId: req.runId }),
    });
  },
  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<FredCsvRows> {
    return parseFredCsv(raw, ctx);
  },
};

/** `true` when this record is the ECO calendar rather than the release catalogue. */
export function isCalendarPage(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/releases/calendar');
  } catch {
    return false;
  }
}

/**
 * `fred.calendar` — the ECO calendar and the release catalogue.
 *
 * `normalise` returns the union of the two page shapes, discriminated by the presence of
 * `advertisedCount`; a caller that fetched a known page can call `normaliseCalendar` or
 * `parseReleaseCatalogue` directly and keep its types narrow.
 */
export const fredCalendarAdapter: ProviderAdapter<
  FredCalendarRequest,
  FredCalendarRows | FredCatalogueRows
> = {
  id: 'fred.calendar',
  sourceId: 'fred.calendar',
  adapterVersion: FRED_ADAPTER_VERSION,
  fetch(http: HttpClient, req: FredCalendarRequest): Promise<RawRecord> {
    const page = req.page ?? 'calendar';
    return http.get({
      providerId: 'fred.calendar',
      url: page === 'calendar' ? FRED_CALENDAR_URL : fredCatalogueUrl(req.pageId),
      headers: { accept: 'text/html' },
      cacheTtlMs: req.cacheTtlMs ?? FRED_CALENDAR_CACHE_TTL_MS,
      ...(req.traceId === undefined ? {} : { traceId: req.traceId }),
      ...(req.runId === undefined ? {} : { runId: req.runId }),
    });
  },
  normalise(
    raw: RawRecord,
    ctx: NormaliseContext,
  ): Normalised<FredCalendarRows | FredCatalogueRows> {
    return isCalendarPage(raw.url) ? normaliseCalendar(raw, ctx) : parseReleaseCatalogue(raw, ctx);
  },
};

/** Register both FRED adapters. Neither is scheduler-only: ECO reads them interactively. */
export function registerFredAdapters(registry: ProviderRegistry): ProviderRegistry {
  registry.register(fredCsvAdapter);
  registry.register(fredCalendarAdapter);
  return registry;
}
