/**
 * `fed.rss` — the impure half. PROVIDERS.b §11.2, §2.2, WORKPLAN WP-05.
 *
 * `GET https://www.federalreserve.gov/feeds/press_all.xml`, polled every 60 s by `newsRss.ts` with
 * `cacheTtlMs 0` and `If-Modified-Since` (the Fed serves `Last-Modified`, not an ETag, which is
 * the one transport difference from §11.1).
 *
 * The contrast with `bbg.rss` is the point of having both: the same screen shows a Bloomberg
 * headline that cannot be exported next to a Fed headline that can, and the entitlement evaluator
 * gets both answers from `licence_registry` — `fed.rss` is `public_domain` with
 * `display/non_display/derived/redistribution` all true. Nothing about that lives in this file;
 * what lives here is stamping the right `source_id` so the evaluator can find the row.
 */

import type { HttpClient, ProviderAdapter, RawRecord } from '../types.js';
import type { FedRssRows } from './parse.js';
import { normaliseFedRss } from './parse.js';

export const FED_PRESS_FEED_URL = 'https://www.federalreserve.gov/feeds/press_all.xml';

export const FED_RSS_ADAPTER_VERSION = 'fed/1.0.0';

/** §11.2: 60 s. */
export const FED_RSS_POLL_INTERVAL_MS = 60_000;

/** §11.2: always revalidate; `If-Modified-Since` does the work. */
export const FED_RSS_CACHE_TTL_MS = 0;

export interface FedRssRequest {
  /** `If-Modified-Since` — the Fed publishes `Last-Modified`, not an ETag. */
  lastModified?: string;
  traceId?: string;
  runId?: number;
}

export async function fetchFedRss(http: HttpClient, req: FedRssRequest = {}): Promise<RawRecord> {
  const headers: Record<string, string> = {
    accept: 'application/rss+xml, application/xml',
  };
  if (req.lastModified !== undefined) headers['if-modified-since'] = req.lastModified;
  const request: Parameters<HttpClient['get']>[0] = {
    providerId: 'fed.rss',
    url: FED_PRESS_FEED_URL,
    headers,
    cacheTtlMs: FED_RSS_CACHE_TTL_MS,
    budgetShare: 'scheduler',
  };
  if (req.traceId !== undefined) request.traceId = req.traceId;
  if (req.runId !== undefined) request.runId = req.runId;
  return http.get(request);
}

export const fedRssAdapter: ProviderAdapter<FedRssRequest, FedRssRows> = {
  id: 'fed.rss',
  sourceId: 'fed.rss',
  adapterVersion: FED_RSS_ADAPTER_VERSION,
  fetch: fetchFedRss,
  normalise: normaliseFedRss,
};
