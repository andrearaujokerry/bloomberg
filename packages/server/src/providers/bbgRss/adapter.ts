/**
 * `bbg.rss` — the impure half. PROVIDERS.b §11.1, §2.2, WORKPLAN WP-05.
 *
 * Six feeds, one `ProviderId`, one bucket, and one detail that decides whether any of it works:
 * **the URL the adapter asks for is not the URL the capture is keyed on.**
 * `https://feeds.bloomberg.com/markets/news.rss` answers `301` to
 * `https://www.bloomberg.com/feeds/markets/news.rss`, `RawRecord.url` is the **post-redirect**
 * canonical URL (§1.1), and the `requestKey` is computed on that. So:
 *
 *  - {@link bbgFeedUrl} returns the `www.bloomberg.com` form — the one the manifest records and
 *    the one a replay lookup will find;
 *  - {@link bbgFeedRedirectUrl} returns the historical `feeds.bloomberg.com` form, kept because
 *    `scripts/fixtures-urls.ts` and a `record`-mode session need to know where the redirect starts;
 *  - `providers/http.ts` follows at most three redirections and refuses any hop that leaves
 *    `*.bloomberg.com` — a `301` chain off the domain is a hard failure, because a hijacked feed
 *    must not be parsed.
 *
 * `cacheTtlMs 0` with `If-None-Match`: Bloomberg serves ETags and most 60-second polls are `304`,
 * which writes no provenance row and emits no update (§1.3).
 */

import type { HttpClient, ProviderAdapter, RawRecord } from '../types.js';
import type { BbgFeed, BbgRssRows } from './parse.js';
import { BBG_FEEDS, normaliseBbgRss } from './parse.js';

/** The post-redirect host — what the manifest records (§11.1). */
export const BBG_FEED_HOST = 'https://www.bloomberg.com';

/** The advertised host, which 301s to {@link BBG_FEED_HOST}. */
export const BBG_FEED_REDIRECT_HOST = 'https://feeds.bloomberg.com';

export const BBG_RSS_ADAPTER_VERSION = 'bbg/1.0.0';

/** §11.1: 60 s per feed, round-robin, so the six feeds cost one request per 10 s. */
export const BBG_RSS_POLL_INTERVAL_MS = 60_000;

/** §11.1: always revalidate; the ETag does the work. */
export const BBG_RSS_CACHE_TTL_MS = 0;

/** The canonical, post-redirect feed URL. */
export function bbgFeedUrl(feed: BbgFeed): string {
  return `${BBG_FEED_HOST}/feeds/${feed}/news.rss`;
}

/** The pre-redirect URL, for the fixtures recorder. */
export function bbgFeedRedirectUrl(feed: BbgFeed): string {
  return `${BBG_FEED_REDIRECT_HOST}/${feed}/news.rss`;
}

export interface BbgRssRequest {
  feed: BbgFeed;
  /** `If-None-Match` — Bloomberg serves ETags and most polls are `304`. */
  etag?: string;
  traceId?: string;
  runId?: number;
}

export async function fetchBbgRss(http: HttpClient, req: BbgRssRequest): Promise<RawRecord> {
  const headers: Record<string, string> = {
    accept: 'application/rss+xml, application/xml',
  };
  if (req.etag !== undefined) headers['if-none-match'] = req.etag;
  const request: Parameters<HttpClient['get']>[0] = {
    providerId: 'bbg.rss',
    url: bbgFeedUrl(req.feed),
    headers,
    cacheTtlMs: BBG_RSS_CACHE_TTL_MS,
    budgetShare: 'scheduler',
  };
  if (req.traceId !== undefined) request.traceId = req.traceId;
  if (req.runId !== undefined) request.runId = req.runId;
  return http.get(request);
}

export const bbgRssAdapter: ProviderAdapter<BbgRssRequest, BbgRssRows> = {
  id: 'bbg.rss',
  sourceId: 'bbg.rss',
  adapterVersion: BBG_RSS_ADAPTER_VERSION,
  fetch: fetchBbgRss,
  normalise: normaliseBbgRss,
};

export { BBG_FEEDS };
export type { BbgFeed };
