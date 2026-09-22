/**
 * `providers/sec/adapter.ts` — the six SEC EDGAR adapters, PROVIDERS §7 (L1252-1733).
 *
 * The impure half of the fetch/normalise split (§1.2): this module builds URLs and headers and
 * hands them to `providers/http.ts`. It never parses a byte, never writes a row, and never reads
 * `process.env` — `SEC_USER_AGENT` reaches the wire through `providerDefaults('sec.…')`, which is
 * the only place the fair-access header is spelled.
 *
 * ## What the six share (§7 preamble)
 *
 * - **Headers.** `User-Agent: ${SEC_USER_AGENT}` and `Accept-Encoding: gzip, deflate`, both from
 *   `providerDefaults`. A default UA gets a `403` with an HTML body, which the client reports as
 *   `ProviderHttpError`, never as "no filings". Each adapter adds only its own `Accept`.
 * - **One bucket, 10 req/s**, shared across all six (the scheduler's 70 % share is 7 req/s).
 * - **Two hosts.** `www.sec.gov` serves `company_tickers.json`, the 8-K atom feed and `/Archives`;
 *   `data.sec.gov` serves `submissions`, `companyfacts` and `frames`. One fair-access policy, one
 *   bucket — which `providerDefaults` gets right because it buckets by *family*, not by host.
 * - **CIK form.** `data.sec.gov` URLs need the **padded** form (`CIK0000320193.json`); `/Archives`
 *   URLs need the **unpadded** form (`884394`). `core/ids/cik.ts` is the only converter, and
 *   getting this backwards produces a 404 that looks like a delisting.
 * - **`efts.sec.gov` (full-text search) is blocked from this network** (BRIEF §2) and is not used.
 *
 * Every builder returns `string | null` rather than throwing: a malformed CIK is a data matter the
 * caller reports, not an exception that takes a scheduler tick down.
 */

import { cikUrlKey, unpadCik } from '@terminal/core';

import {
  SEC_ADAPTER_VERSION,
  normaliseAtom,
  normaliseCompanyFacts,
  normaliseFrames,
  normaliseNport,
  normaliseSubmissions,
  normaliseTickers,
  stripXslPrefix,
} from './parse.js';

import type {
  SecAtomRows,
  SecCompanyFactsRows,
  SecFramesRows,
  SecNportRows,
  SecSubmissionsRows,
  SecTickersRows,
} from './parse.js';
import type { HttpClient, ProviderAdapter, RawRecord } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Hosts and cache policy
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SEC_WWW = 'https://www.sec.gov';
export const SEC_DATA = 'https://data.sec.gov';

/** §7.1: SEC rewrites `company_tickers.json` daily; a 304 costs no provenance row and no work. */
export const TICKERS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** §7.6: an Archives document is immutable once filed, so a repeat fetch is free through the ETag. */
export const ARCHIVES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** §7.5: one page of the current-filings feed. */
export const ATOM_DEFAULT_COUNT = 40;

/** JSON is what both `data.sec.gov` APIs and `company_tickers.json` serve. */
const JSON_ACCEPT: Readonly<Record<string, string>> = { accept: 'application/json' };

/** §7.5: the feed is `application/atom+xml`; asking for it is what keeps the HTML page away. */
const ATOM_ACCEPT: Readonly<Record<string, string>> = { accept: 'application/atom+xml, text/xml' };

/** §7.6: an Archives primary document is XML. */
const XML_ACCEPT: Readonly<Record<string, string>> = { accept: 'application/xml, text/xml' };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// URL builders — pure, total, and the only spelling of every SEC endpoint
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §7.1 `GET https://www.sec.gov/files/company_tickers.json`. */
export function tickersUrl(): string {
  return `${SEC_WWW}/files/company_tickers.json`;
}

/** §7.2 `GET https://data.sec.gov/submissions/CIK##########.json` (padded). */
export function submissionsUrl(cik: string | number): string | null {
  const key = cikUrlKey(cik);
  return key === null ? null : `${SEC_DATA}/submissions/${key}.json`;
}

/** §7.2: one of the `filings.files[]` overflow indexes, followed only during the seed backfill. */
export function submissionsOverflowUrl(name: string): string | null {
  return /^[A-Za-z0-9_.-]+\.json$/.test(name) ? `${SEC_DATA}/submissions/${name}` : null;
}

/** §7.3 `GET https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` (padded). */
export function companyFactsUrl(cik: string | number): string | null {
  const key = cikUrlKey(cik);
  return key === null ? null : `${SEC_DATA}/api/xbrl/companyfacts/${key}.json`;
}

/**
 * §7.4 `GET https://data.sec.gov/api/xbrl/frames/{taxonomy}/{concept}/{unit}/{frame}.json`.
 *
 * The unit appears in a **path segment**, so `USD/shares` is spelled `USD-per-shares` — SEC's own
 * convention, and the reason this builder exists rather than a template literal at the call site.
 * `frame` is `CY2024Q4I` for an instant (balance-sheet) concept and `CY2024Q4` for a duration.
 */
export function framesUrl(
  concept: string,
  unit: string,
  frame: string,
  taxonomy = 'us-gaap',
): string | null {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(concept)) return null;
  if (!/^CY\d{4}(Q[1-4])?I?$/.test(frame)) return null;
  const unitSegment = unit.replace(/\//g, '-per-');
  if (!/^[A-Za-z0-9-]+$/.test(unitSegment)) return null;
  return `${SEC_DATA}/api/xbrl/frames/${taxonomy}/${concept}/${unitSegment}/${frame}.json`;
}

/** §7.5 `GET https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=40&output=atom`. */
export function atomUrl(type = '8-K', count = ATOM_DEFAULT_COUNT): string {
  const params = new URLSearchParams({
    action: 'getcurrent',
    type,
    count: String(count),
    output: 'atom',
  });
  return `${SEC_WWW}/cgi-bin/browse-edgar?${params.toString()}`;
}

/**
 * §7.6 `GET https://www.sec.gov/Archives/edgar/data/<unpadded cik>/<accession, no dashes>/<doc>`.
 *
 * The accession loses its dashes for the path, the CIK is **unpadded**, and a leading `xsl…/`
 * segment is stripped: that prefix names the styled viewer and returns HTML (§7.2's XSL trap).
 */
export function nportUrl(
  cik: string | number,
  accession: string,
  document = 'primary_doc.xml',
): string | null {
  const bare = unpadCik(cik);
  if (bare === null) return null;
  const path = accession.replace(/-/g, '');
  if (!/^\d{18}$/.test(path)) return null;
  const doc = stripXslPrefix(document.trim());
  if (doc === '' || doc.includes('..')) return null;
  return `${SEC_WWW}/Archives/edgar/data/${bare}/${path}/${doc}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Request types — what a job hands each adapter's `fetch`
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Fields every SEC request may carry through to `provenance` (OPS-07, `ingest_runs.run_id`). */
export interface SecRequestBase {
  traceId?: string;
  runId?: number;
  budgetShare?: 'scheduler' | 'interactive';
  /** Replay only: walk successive captures of one key (§3.3). */
  captureIndex?: number;
  /** Overrides the adapter's default (§2.4). */
  cacheTtlMs?: number;
}

/** §7.1 takes no parameters: there is one file. */
export type SecTickersRequest = SecRequestBase;

export interface SecCikRequest extends SecRequestBase {
  cik: string | number;
}
export interface SecFramesRequest extends SecRequestBase {
  concept: string;
  unit: string;
  frame: string;
  taxonomy?: string;
}
export interface SecAtomRequest extends SecRequestBase {
  type?: string;
  count?: number;
}
export interface SecArchivesRequest extends SecRequestBase {
  cik: string | number;
  accession: string;
  /** As published, `xsl…/` prefix and all — this builder strips it. */
  document?: string;
}

/** Thrown by a `fetch` whose request cannot become a URL. Never by a parser. */
export class SecRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecRequestError';
  }
}

/**
 * The one place a `SecRequestBase` becomes the optional half of an `HttpRequest`.
 *
 * Built by assignment rather than by spreading `undefined`s, because `exactOptionalPropertyTypes`
 * makes `{ traceId: undefined }` and `{}` different types, and the second is what `http.ts` means.
 */
function options(
  request: SecRequestBase,
  defaultTtlMs: number,
): {
  cacheTtlMs: number;
  traceId?: string;
  runId?: number;
  budgetShare?: 'scheduler' | 'interactive';
  captureIndex?: number;
} {
  const out: {
    cacheTtlMs: number;
    traceId?: string;
    runId?: number;
    budgetShare?: 'scheduler' | 'interactive';
    captureIndex?: number;
  } = { cacheTtlMs: request.cacheTtlMs ?? defaultTtlMs };
  if (request.traceId !== undefined) out.traceId = request.traceId;
  if (request.runId !== undefined) out.runId = request.runId;
  if (request.budgetShare !== undefined) out.budgetShare = request.budgetShare;
  if (request.captureIndex !== undefined) out.captureIndex = request.captureIndex;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The six adapters
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §7.1 — ticker → CIK, the join that makes everything else possible. */
export const secTickersAdapter: ProviderAdapter<SecTickersRequest, SecTickersRows> = {
  id: 'sec.tickers',
  sourceId: 'sec.tickers',
  adapterVersion: SEC_ADAPTER_VERSION,
  fetch(http: HttpClient, request: SecTickersRequest = {}): Promise<RawRecord> {
    return http.get({
      providerId: 'sec.tickers',
      url: tickersUrl(),
      headers: { ...JSON_ACCEPT },
      ...options(request, TICKERS_CACHE_TTL_MS),
    });
  },
  normalise: normaliseTickers,
};

/** §7.2 — the filing index and the issuer's own description of itself. */
export const secSubmissionsAdapter: ProviderAdapter<SecCikRequest, SecSubmissionsRows> = {
  id: 'sec.submissions',
  sourceId: 'sec.submissions',
  adapterVersion: SEC_ADAPTER_VERSION,
  fetch(http: HttpClient, request: SecCikRequest): Promise<RawRecord> {
    const url = submissionsUrl(request.cik);
    if (url === null) {
      return Promise.reject(
        new SecRequestError(`sec.submissions: '${String(request.cik)}' is not a CIK`),
      );
    }
    return http.get({
      providerId: 'sec.submissions',
      url,
      headers: { ...JSON_ACCEPT },
      ...options(request, 0),
    });
  },
  normalise: normaliseSubmissions,
};

/** §7.3 — point-in-time fundamentals (DATA-06, STOR-06). */
export const secCompanyFactsAdapter: ProviderAdapter<SecCikRequest, SecCompanyFactsRows> = {
  id: 'sec.companyfacts',
  sourceId: 'sec.companyfacts',
  adapterVersion: SEC_ADAPTER_VERSION,
  fetch(http: HttpClient, request: SecCikRequest): Promise<RawRecord> {
    const url = companyFactsUrl(request.cik);
    if (url === null) {
      return Promise.reject(
        new SecRequestError(`sec.companyfacts: '${String(request.cik)}' is not a CIK`),
      );
    }
    // §7.3: 3.7 MB per issuer, so the job is ETag-gated and re-parses only on a 200.
    return http.get({
      providerId: 'sec.companyfacts',
      url,
      headers: { ...JSON_ACCEPT },
      ...options(request, 0),
    });
  },
  normalise: normaliseCompanyFacts,
};

/** §7.4 — the cross-sectional cut for EQS. Never fetched interactively. */
export const secFramesAdapter: ProviderAdapter<SecFramesRequest, SecFramesRows> = {
  id: 'sec.frames',
  sourceId: 'sec.frames',
  adapterVersion: SEC_ADAPTER_VERSION,
  fetch(http: HttpClient, request: SecFramesRequest): Promise<RawRecord> {
    const url = framesUrl(request.concept, request.unit, request.frame, request.taxonomy);
    if (url === null) {
      return Promise.reject(
        new SecRequestError(
          `sec.frames: (${request.concept}, ${request.unit}, ${request.frame}) is not a frame`,
        ),
      );
    }
    return http.get({
      providerId: 'sec.frames',
      url,
      headers: { ...JSON_ACCEPT },
      ...options(request, 0),
    });
  },
  normalise: normaliseFrames,
};

/** §7.5 — the 8-K current-filings feed (NEWS-04), polled every 60 s. */
export const secAtomAdapter: ProviderAdapter<SecAtomRequest, SecAtomRows> = {
  id: 'sec.atom',
  sourceId: 'sec.atom',
  adapterVersion: SEC_ADAPTER_VERSION,
  fetch(http: HttpClient, request: SecAtomRequest = {}): Promise<RawRecord> {
    return http.get({
      providerId: 'sec.atom',
      url: atomUrl(request.type ?? '8-K', request.count ?? ATOM_DEFAULT_COUNT),
      headers: { ...ATOM_ACCEPT },
      ...options(request, 0),
    });
  },
  normalise: normaliseAtom,
};

/** §7.6 — N-PORT, S&P 500 membership from the fund that tracks it (REF-07). */
export const secArchivesAdapter: ProviderAdapter<SecArchivesRequest, SecNportRows> = {
  id: 'sec.archives',
  sourceId: 'sec.archives',
  adapterVersion: SEC_ADAPTER_VERSION,
  fetch(http: HttpClient, request: SecArchivesRequest): Promise<RawRecord> {
    const url = nportUrl(request.cik, request.accession, request.document ?? 'primary_doc.xml');
    if (url === null) {
      return Promise.reject(
        new SecRequestError(
          `sec.archives: (${String(request.cik)}, ${request.accession}) is not an Archives path`,
        ),
      );
    }
    return http.get({
      providerId: 'sec.archives',
      url,
      headers: { ...XML_ACCEPT },
      ...options(request, ARCHIVES_CACHE_TTL_MS),
    });
  },
  normalise: normaliseNport,
};

/**
 * The six, in `PROVIDER_IDS` order — what `createProviderRegistry` is handed at startup.
 *
 * `sec.frames` is **not** `schedulerOnly`: it is cheap enough to read through, and §7.4 keeps EQS
 * off the network by reading what is stored rather than by a registry flag.
 */
export const secAdapters = [
  secTickersAdapter,
  secSubmissionsAdapter,
  secCompanyFactsAdapter,
  secFramesAdapter,
  secAtomAdapter,
  secArchivesAdapter,
] as const;
