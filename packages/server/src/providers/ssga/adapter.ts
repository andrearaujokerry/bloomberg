/**
 * `providers/ssga/adapter.ts` — the SPDR S&P 500 daily holdings file, PROVIDERS §8.1 (L1734-1816).
 *
 * One endpoint, one request a day, ~53 KB. The impure half of the split (§1.2): a URL, two headers
 * and `http.ts`. It never opens the workbook — `providers/ssga/parse.ts` does that, purely.
 *
 * ## Why this adapter needs a browser User-Agent
 *
 * The SSGA CDN serves an HTML page to an unfamiliar agent, with status `200`. `providerDefaults`
 * puts `BROWSER_USER_AGENT` on every `ssga.*` request for exactly that reason (§2.2), and
 * `normaliseSsgaHoldings` refuses any body that does not begin with the ZIP signature `PK` — so
 * the failure surfaces as a `ProviderHttpError` that trips the breaker, never as a day on which
 * the S&P 500 happened to have no constituents.
 *
 * ## Licence, and why it is the one `vendor_terms` row in this system
 *
 * `ssga.holdings` is an **issuer publication, not a regulatory filing**: `redistribution false`,
 * `api_allowed false`, and the S&P 500 name is a trademark we hold no index licence for (DATA-01
 * gap, stated on MEMB). `index_members.source_id` is what distinguishes these rows from the
 * `sec.archives` ones, and `indices.membership_source_id` stays `'sec.archives'` — the official
 * source — while both are present.
 */

import { SSGA_ADAPTER_VERSION, normaliseSsgaHoldings } from './parse.js';

import type { SsgaHoldingsRows } from './parse.js';
import type { HttpClient, ProviderAdapter, RawRecord } from '../types.js';

/** §8.1: the daily file. The path carries the fund in its name, hence the builder. */
export const SSGA_HOLDINGS_BASE =
  'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us';

/** §8.1: the SPDR S&P 500 ETF Trust file — the only one v1 fetches. */
export const SSGA_SPY_URL = `${SSGA_HOLDINGS_BASE}/holdings-daily-us-en-spy.xlsx`;

/** §8.1: daily at 19:00 ET; one request per day is plenty of freshness for a 16:00 file. */
export const SSGA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * §8.1 headers. The `User-Agent` is added by `providerDefaults('ssga.holdings')`; this is the
 * `Accept` that tells the CDN we want the workbook and not its landing page.
 */
const XLSX_ACCEPT: Readonly<Record<string, string>> = {
  accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*',
};

/**
 * `holdings-daily-us-en-<fund>.xlsx`, or `null` when `fund` is not a plain ticker slug.
 *
 * The guard is not decoration: this string becomes a path segment, and an unchecked one is how a
 * job parameter turns into a request for something else entirely.
 */
export function ssgaHoldingsUrl(fund: string): string {
  const slug = fund.trim().toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(slug)) {
    throw new SsgaRequestError(`ssga.holdings: '${fund}' is not a fund slug`);
  }
  return `${SSGA_HOLDINGS_BASE}/holdings-daily-us-en-${slug}.xlsx`;
}

/** Thrown by a `fetch` whose request cannot become a URL. Never by the parser. */
export class SsgaRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsgaRequestError';
  }
}

export interface SsgaHoldingsRequest {
  /** Default `'spy'`. */
  fund?: string;
  traceId?: string;
  runId?: number;
  budgetShare?: 'scheduler' | 'interactive';
  captureIndex?: number;
  cacheTtlMs?: number;
}

/** §8.1 — the issuer's daily S&P 500 file. */
export const ssgaHoldingsAdapter: ProviderAdapter<SsgaHoldingsRequest, SsgaHoldingsRows> = {
  id: 'ssga.holdings',
  sourceId: 'ssga.holdings',
  adapterVersion: SSGA_ADAPTER_VERSION,
  fetch(http: HttpClient, request: SsgaHoldingsRequest = {}): Promise<RawRecord> {
    let url: string;
    try {
      url = ssgaHoldingsUrl(request.fund ?? 'spy');
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new SsgaRequestError(String(err)));
    }
    // Built by assignment rather than by spreading `undefined`s: `exactOptionalPropertyTypes`
    // makes `{ traceId: undefined }` and `{}` different types, and the second is what `http.ts`
    // means by "no trace id".
    const req: Parameters<HttpClient['get']>[0] = {
      providerId: 'ssga.holdings',
      url,
      headers: { ...XLSX_ACCEPT },
      cacheTtlMs: request.cacheTtlMs ?? SSGA_CACHE_TTL_MS,
    };
    if (request.traceId !== undefined) req.traceId = request.traceId;
    if (request.runId !== undefined) req.runId = request.runId;
    if (request.budgetShare !== undefined) req.budgetShare = request.budgetShare;
    if (request.captureIndex !== undefined) req.captureIndex = request.captureIndex;
    return http.get(req);
  },
  normalise: normaliseSsgaHoldings,
};

/** What `createProviderRegistry` is handed at startup. */
export const ssgaAdapters = [ssgaHoldingsAdapter] as const;
