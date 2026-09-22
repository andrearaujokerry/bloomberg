/**
 * `worldbank` — the impure half. PROVIDERS.b §10.7, §2.2, WORKPLAN WP-05.
 *
 * `GET https://api.worldbank.org/v2/country/{ISO2}/indicator/{ID}?format=json&per_page=100&page={n}`.
 *
 * Two things the URL builder owes the rest of the system:
 *
 *  - `format=json` is not optional. Without it the API answers XML, which nothing downstream
 *    parses, and it does so with a `200`.
 *  - the query is written in the order `format, page, per_page`, which is the order
 *    `canonicalUrl()` sorts it into (§3.2). The recorded capture's key was computed on exactly
 *    that spelling; writing the parameters in any other order still produces the same key, but
 *    writing them the same way keeps the manifest diff readable.
 *
 * Paging is the caller's (`ingest/jobs/worldMacro.ts`): walk `meta.pages` ascending, capped at
 * {@link WORLDBANK_MAX_PAGES}. With `per_page=100` a 66-observation series is one request.
 */

import type { HttpClient, ProviderAdapter, RawRecord } from '../types.js';
import type { WorldBankRows } from './parse.js';
import { normaliseWorldBank } from './parse.js';

export const WORLDBANK_BASE_URL = 'https://api.worldbank.org/v2';

export const WORLDBANK_ADAPTER_VERSION = 'worldbank/1.0.0';

/** §10.7: weekly job, so a day-old copy is always fine. */
export const WORLDBANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** §10.7: the page walk is capped, so a runaway `pages` cannot spend the bucket. */
export const WORLDBANK_MAX_PAGES = 10;

/** §10.7: 100 observations a page — a 66-year series is one request. */
export const WORLDBANK_PER_PAGE = 100;

export interface WorldBankRequest {
  /** ISO-2 country code, or an aggregate code such as `'WLD'`; used verbatim in the path. */
  country: string;
  /** `'NY.GDP.MKTP.CD'`. */
  indicator: string;
  /** 1-based; default 1. */
  page?: number;
  /** Default {@link WORLDBANK_PER_PAGE}. */
  perPage?: number;
  traceId?: string;
  runId?: number;
}

/** The full URL for one page of one indicator (§10.7). */
export function worldBankUrl(req: WorldBankRequest): string {
  const page = req.page ?? 1;
  const perPage = req.perPage ?? WORLDBANK_PER_PAGE;
  const country = encodeURIComponent(req.country);
  const indicator = encodeURIComponent(req.indicator);
  return (
    `${WORLDBANK_BASE_URL}/country/${country}/indicator/${indicator}` +
    `?format=json&page=${String(page)}&per_page=${String(perPage)}`
  );
}

export async function fetchWorldBank(http: HttpClient, req: WorldBankRequest): Promise<RawRecord> {
  const request: Parameters<HttpClient['get']>[0] = {
    providerId: 'worldbank',
    url: worldBankUrl(req),
    cacheTtlMs: WORLDBANK_CACHE_TTL_MS,
    budgetShare: 'scheduler',
  };
  if (req.traceId !== undefined) request.traceId = req.traceId;
  if (req.runId !== undefined) request.runId = req.runId;
  return http.get(request);
}

export const worldBankAdapter: ProviderAdapter<WorldBankRequest, WorldBankRows> = {
  id: 'worldbank',
  sourceId: 'worldbank',
  adapterVersion: WORLDBANK_ADAPTER_VERSION,
  fetch: fetchWorldBank,
  normalise: normaliseWorldBank,
};
