/**
 * Provenance and the licence registry (DATA-09, DATA-10, STOR-07) — ARCHITECTURE §9,
 * DATA_MODEL `provenance` / `licence_registry`.
 *
 * Every value-bearing row carries a `provenanceId`; `QuoteState` carries `prov` per line and for the
 * composite; function payloads carry `meta.provenance[]` and each block cites an index into it.
 */

import type { Tier } from './quote.js';

/** One raw provider exchange (DATA-10). Timestamps are ISO-8601 UTC strings. */
export interface ProvenanceRecord {
  provenanceId: number;
  /** licence_registry.source_id */
  sourceId: string;
  /** replay store key: sha256(providerId|METHOD|url-sorted-query|sha256(body)) hex (ARCHITECTURE §8.1) */
  requestKey: string;
  requestUrl: string;
  /** hex sha256 of (method + url + body) */
  requestHash: string;
  /** hex sha256 of the response body */
  responseSha256: string;
  httpStatus: number;
  bytes: number;
  /** FEED-05 'cap' */
  capturedAt: string;
  /** provider-published time when present (FEED-05 'src'); null when the provider gives none */
  sourceTs: string | null;
  /** 'cboe/1.0.0' */
  adapterVersion: string;
  /** when fetched on behalf of a request (OPS-07) */
  traceId?: string;
  /** ingest_runs.run_id when fetched by the scheduler */
  runId?: number;
}

export type LicenceKind =
  | 'public_domain'
  | 'open_data'
  | 'exchange_delayed'
  | 'unofficial'
  | 'cc_by_sa'
  | 'vendor_terms'
  | 'internal';

/**
 * One bitemporal `licence_registry` version: the machine-readable terms of a source. The only input
 * to the evaluator's source dimension; `retentionDays` is the only input to partition dropping and
 * `retentionPurge` (STOR-07).
 */
export interface LicenceEntry {
  versionId: number;
  /** 'cboe.quotes', 'yahoo.chart', 'nyfed.rates', … */
  sourceId: string;
  sourceName: string;
  publisher: string;
  termsUrl: string | null;
  /** DATA-01: signed agreement reference; null for every v1 public source */
  contractRef: string | null;
  licenceKind: LicenceKind;
  display: boolean;
  /** DATA-01 distinction: programmatic / non-display use */
  nonDisplay: boolean;
  derived: boolean;
  redistribution: boolean;
  exportAllowed: boolean;
  apiAllowed: boolean;
  /** ceiling any grant can reach for this source (evaluator rule 3) */
  maxTier: Tier;
  intrinsicDelayMin: number;
  /** null = unlimited; the ONLY input to partition drops and retentionPurge (STOR-07) */
  retentionDays: number | null;
  /** shown in screen footers and as the CSV header attribution line */
  attribution: string;
  /** '25/min', '10/s' — documentation; buckets live in providers/http.ts */
  rateLimit: string;
  requiresUserAgent: boolean;
  /** 'OPENFIGI_API_KEY', 'FRED_API_KEY' */
  apiKeyEnv: string | null;
  auditObligation: string | null;
  notes: string | null;
  /** half-open [validFrom, validTo); ISO-8601 UTC, 'infinity' allowed */
  validFrom: string;
  validTo: string;
  txFrom: string;
  txTo: string;
  /** null only for rows written by seed/licences.ts (bootstrap) */
  provenanceId: number | null;
}
