/**
 * `openfigi.mapping` — the impure half. PROVIDERS.a §6.1, §6.2, §2.2 (bucket), WORKPLAN WP-05.
 *
 * Builds URLs, headers and the POST body; returns a `RawRecord` through `HttpClient` and parses
 * nothing. OpenFIGI is the only adapter that POSTs and the only one whose request **body**
 * participates in the replay key (§3.2), which is why {@link openFigiMappingRequest} sorts and
 * chunks the job array before serialising it: an unsorted list produces a different key on every
 * run and every recorded capture misses.
 *
 * The `Content-Type`, `Accept` and `X-OPENFIGI-APIKEY` headers are the per-provider defaults in
 * `providers/http.ts#providerDefaults` (which is the only place allowed to see the key, since
 * `config.ts` is the only reader of the environment). Nothing here adds a header; a caller may
 * still override one through `HttpRequest.headers`.
 */

import type { HttpClient, ProviderAdapter, RawRecord } from '../types.js';
import type { OpenFigiJob, OpenFigiRows } from './parse.js';
import { normaliseOpenFigi, openFigiMappingBody, sortOpenFigiJobs } from './parse.js';

/** §6.1. */
export const OPENFIGI_MAPPING_URL = 'https://api.openfigi.com/v3/mapping';

/** §6.2. */
export const OPENFIGI_SEARCH_URL = 'https://api.openfigi.com/v3/search';

/** `provenance.adapter_version` — one version for both endpoints (§6, §1.4). */
export const OPENFIGI_ADAPTER_VERSION = 'openfigi/1.0.0';

/**
 * Keyless ceiling: 10 jobs per request. With `OPENFIGI_API_KEY` the documented ceiling is 100, and
 * it is read from config by the caller (`config.OPENFIGI_JOBS_PER_REQUEST`, §6.1 step 5) — never
 * hard-coded at the call site, so the seed drops from 62 minutes to 5 without a code change.
 */
export const OPENFIGI_KEYLESS_JOBS_PER_REQUEST = 10;

/** §6.2: `cacheTtlMs 5 min` on the canonical URL + body. */
export const OPENFIGI_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

/** A `/v3/mapping` call: one chunk of at most `jobsPerRequest` jobs. */
export interface OpenFigiMappingRequest {
  kind: 'mapping';
  jobs: readonly OpenFigiJob[];
  /** OPS-07. */
  traceId?: string;
  runId?: number;
  budgetShare?: 'scheduler' | 'interactive';
}

/** A `/v3/search` call: one keystroke's worth of interactive resolution (§6.2). */
export interface OpenFigiSearchRequest {
  kind: 'search';
  query: string;
  /** `'US'` for the US composite universe; omitted to search every venue. */
  exchCode?: string;
  /** The opaque cursor from the previous page (§6.2: at most three pages). */
  start?: string;
  traceId?: string;
  runId?: number;
  budgetShare?: 'scheduler' | 'interactive';
}

export type OpenFigiRequest = OpenFigiMappingRequest | OpenFigiSearchRequest;

/**
 * Chunk a job list into request-sized groups, sorted first so the bodies — and therefore the
 * request keys — are stable (§6.1 step 1).
 *
 * @param jobsPerRequest the configured ceiling; values below 1 are treated as 1.
 */
export function chunkOpenFigiJobs(
  jobs: readonly OpenFigiJob[],
  jobsPerRequest: number = OPENFIGI_KEYLESS_JOBS_PER_REQUEST,
): OpenFigiJob[][] {
  const size = Math.max(1, Math.floor(jobsPerRequest));
  const sorted = sortOpenFigiJobs(jobs);
  const chunks: OpenFigiJob[][] = [];
  for (let i = 0; i < sorted.length; i += size) chunks.push(sorted.slice(i, i + size));
  return chunks;
}

/** The exact body bytes for a `/v3/search` call (§6.2). Key order is fixed, so the key is stable. */
export function openFigiSearchBody(req: OpenFigiSearchRequest): string {
  const body: { query: string; exchCode?: string; start?: string } = { query: req.query };
  if (req.exchCode !== undefined) body.exchCode = req.exchCode;
  if (req.start !== undefined) body.start = req.start;
  return JSON.stringify(body);
}

/** The exact body bytes for a `/v3/mapping` call (§6.1). */
export function openFigiRequestBody(req: OpenFigiRequest): string {
  return req.kind === 'mapping' ? openFigiMappingBody(req.jobs) : openFigiSearchBody(req);
}

/** The endpoint a request goes to. */
export function openFigiRequestUrl(req: OpenFigiRequest): string {
  return req.kind === 'mapping' ? OPENFIGI_MAPPING_URL : OPENFIGI_SEARCH_URL;
}

/**
 * POST the request. Never parses, never writes.
 *
 * A mapping chunk larger than the configured ceiling is a code defect, not a data matter, and the
 * provider answers it with `413` (§6.1); the chunker above is what prevents it, and the caller
 * that bypasses the chunker gets the provider's own error.
 */
export async function fetchOpenFigi(http: HttpClient, req: OpenFigiRequest): Promise<RawRecord> {
  const body = openFigiRequestBody(req);
  const request: Parameters<HttpClient['post']>[0] = {
    providerId: 'openfigi.mapping',
    method: 'POST',
    url: openFigiRequestUrl(req),
    body,
    budgetShare: req.budgetShare ?? (req.kind === 'search' ? 'interactive' : 'scheduler'),
  };
  if (req.kind === 'search') request.cacheTtlMs = OPENFIGI_SEARCH_CACHE_TTL_MS;
  if (req.traceId !== undefined) request.traceId = req.traceId;
  if (req.runId !== undefined) request.runId = req.runId;
  return http.post(request);
}

/** The registry entry (PROVIDERS.a §1.1, §6). */
export const openFigiAdapter: ProviderAdapter<OpenFigiRequest, OpenFigiRows> = {
  id: 'openfigi.mapping',
  sourceId: 'openfigi.mapping',
  adapterVersion: OPENFIGI_ADAPTER_VERSION,
  fetch: fetchOpenFigi,
  normalise: normaliseOpenFigi,
};
