/**
 * `finra.shortInterest` — the impure half. PROVIDERS.b §12, §2.2, WORKPLAN WP-05.
 *
 * `GET https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest?limit=1000&offset={n}`
 * with `Accept: text/csv`.
 *
 * The `Accept` header is not decoration. The same endpoint answers JSON with a **different field
 * shape** when asked for it, and the recorded capture is CSV; pinning the representation is what
 * keeps the golden meaningful and the parser honest about what it reads. `FINRA_API_KEY` exists on
 * the licence row and is unused — the keyless tier carries the whole file.
 *
 * Paging is the caller's (`ingest/jobs/shortInterest.ts`): walk `offset` by `limit` until a short
 * page, capped at 20 pages, and short-circuit the whole run when the newest `settlementDate` in
 * the first page is not newer than the stored maximum.
 */

import type { HttpClient, ProviderAdapter, RawRecord } from '../types.js';
import type { ShortInterestRows } from './parse.js';
import { normaliseShortInterest, SHORT_INTEREST_PAGE_LIMIT } from './parse.js';

export const FINRA_SHORT_INTEREST_URL =
  'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';

export const FINRA_ADAPTER_VERSION = 'finra/1.0.0';

export interface ShortInterestRequest {
  /** Default {@link SHORT_INTEREST_PAGE_LIMIT}. */
  limit?: number;
  /** 0-based row offset; default 0. */
  offset?: number;
  traceId?: string;
  runId?: number;
}

/** One page of the consolidated file (§12). */
export function shortInterestUrl(req: ShortInterestRequest = {}): string {
  const limit = req.limit ?? SHORT_INTEREST_PAGE_LIMIT;
  const offset = req.offset ?? 0;
  return `${FINRA_SHORT_INTEREST_URL}?limit=${String(limit)}&offset=${String(offset)}`;
}

export async function fetchShortInterest(
  http: HttpClient,
  req: ShortInterestRequest = {},
): Promise<RawRecord> {
  const request: Parameters<HttpClient['get']>[0] = {
    providerId: 'finra.shortInterest',
    url: shortInterestUrl(req),
    // The representation the parser was written against (§12); JSON has a different shape.
    headers: { accept: 'text/csv' },
    budgetShare: 'scheduler',
  };
  if (req.traceId !== undefined) request.traceId = req.traceId;
  if (req.runId !== undefined) request.runId = req.runId;
  return http.get(request);
}

export const finraShortInterestAdapter: ProviderAdapter<ShortInterestRequest, ShortInterestRows> = {
  id: 'finra.shortInterest',
  sourceId: 'finra.shortInterest',
  adapterVersion: FINRA_ADAPTER_VERSION,
  fetch: fetchShortInterest,
  normalise: normaliseShortInterest,
};
