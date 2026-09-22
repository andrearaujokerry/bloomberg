/**
 * `imf.datamapper` — the impure half. PROVIDERS.b §10.8, §2.2, WORKPLAN WP-05.
 *
 * Two GETs, no query string, no key:
 *
 *  - `GET https://www.imf.org/external/datamapper/api/v1/indicators` — the catalogue;
 *  - `GET https://www.imf.org/external/datamapper/api/v1/{ID}/{ISO3}` — the observations, one
 *    indicator and one area at a time.
 *
 * The licence row is the reason this adapter is quieter than it looks: `imf.datamapper` is
 * `vendor_terms` with `non_display false`, `redistribution false` and `api_allowed false`, so
 * WEO values render on a screen and leave through no other door. The entitlement evaluator gets
 * that from `licence_registry`; the adapter's job is only to stamp the right `source_id` on the
 * provenance row so the evaluator can find it.
 */

import type { HttpClient, ProviderAdapter, RawRecord } from '../types.js';
import type { ImfRows } from './parse.js';
import { normaliseImf } from './parse.js';

export const IMF_BASE_URL = 'https://www.imf.org/external/datamapper/api/v1';

export const IMF_INDICATORS_URL = `${IMF_BASE_URL}/indicators`;

export const IMF_ADAPTER_VERSION = 'imf/1.0.0';

/** §10.8: weekly job (`worldMacro.ts`), so a day-old copy is always fine. */
export const IMF_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The catalogue, or one indicator × area series. */
export type ImfRequest =
  | { kind: 'catalogue'; traceId?: string; runId?: number }
  | {
      kind: 'values';
      /** `'NGDP_RPCH'`. */
      indicator: string;
      /** ISO-3 (`'USA'`) or an IMF aggregate code. */
      area: string;
      traceId?: string;
      runId?: number;
    };

/** The URL for a request (§10.8). */
export function imfUrl(req: ImfRequest): string {
  if (req.kind === 'catalogue') return IMF_INDICATORS_URL;
  return `${IMF_BASE_URL}/${encodeURIComponent(req.indicator)}/${encodeURIComponent(req.area)}`;
}

export async function fetchImf(http: HttpClient, req: ImfRequest): Promise<RawRecord> {
  const request: Parameters<HttpClient['get']>[0] = {
    providerId: 'imf.datamapper',
    url: imfUrl(req),
    cacheTtlMs: IMF_CACHE_TTL_MS,
    budgetShare: 'scheduler',
  };
  if (req.traceId !== undefined) request.traceId = req.traceId;
  if (req.runId !== undefined) request.runId = req.runId;
  return http.get(request);
}

export const imfAdapter: ProviderAdapter<ImfRequest, ImfRows> = {
  id: 'imf.datamapper',
  sourceId: 'imf.datamapper',
  adapterVersion: IMF_ADAPTER_VERSION,
  fetch: fetchImf,
  normalise: normaliseImf,
};
