/**
 * The provider adapter contract — PROVIDERS.a §1.1 (L24-92), §1.2, §1.3.
 *
 * Every byte that becomes a number on a screen enters through exactly one adapter, and every
 * adapter obeys the same five obligations (BRIEF §2): record into the replay store (FEED-08,
 * QA-02), stamp provenance (DATA-10), carry a `licence_registry` row (DATA-09), be rate-limited
 * and cache-aware, and publish enough metadata for the staleness renderer (TERM-12).
 *
 * This module is *only* types plus the `ProviderId` value set. It opens no socket, touches no
 * database and reads no environment: `providers/http.ts` (WP-05) implements `HttpClient`,
 * `providers/replayStore.ts` implements the fixture store, `providers/provenance.ts` writes the
 * row, and `providers/registry.ts` holds the adapters.
 *
 * Two deliberate additions to the declaration in PROVIDERS.a §1.1, both carried under §18 and both
 * noted where they appear: `RawRecord.sourceTs` (so the record that the replay store round-trips
 * carries the provider-published instant it was captured with — `manifest.json` has always stored
 * it, and `insertProvenance` needs it for a replayed record that no normaliser has run over yet),
 * and `HttpRequest`/`HttpClient` living here rather than in `http.ts` (PROVIDERS.a §2, L228-250,
 * verbatim) so that `ProviderAdapter.fetch` can name its client without this file depending on the
 * implementation that imports it.
 */

import type { AssetClass, IdScheme, NormalisedUpdate, Tier } from '@terminal/core';

import type { ProviderMode } from '../config.js';
import { isKnownSourceId, licenceSourceIds } from './licences.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ProviderId
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The source ids in `licence_registry` that are **not** HTTP adapters: `wiki.sp500` is a committed
 * fixture parsed by `refdata/classifications.ts`, and the two `internal.*` sources are written by
 * this system itself (derived analytics, data-ops corrections). PROVIDERS.a §1.1 L22-23.
 */
export const NON_ADAPTER_SOURCE_IDS = ['wiki.sp500', 'internal.derived', 'internal.user'] as const;

export type NonAdapterSourceId = (typeof NON_ADAPTER_SOURCE_IDS)[number];

/**
 * Every adapter id, in the order of PROVIDERS.a §1.1. The tuple is the type carrier — TypeScript
 * cannot lift literal types out of `licenceRows` (it is annotated `readonly LicenceRow[]`, so the
 * strings are widened to `string` at that boundary) — but it is *not* an independent source of
 * truth: `assertProviderIdsMatchLicences()` below runs at module load and fails the process if this
 * tuple and `licences.ts` ever disagree. An adapter id IS a `licence_registry.source_id`
 * (`assert_source_known` enforces the same thing in the database), so the two cannot be allowed to
 * drift silently.
 */
export const PROVIDER_IDS = [
  'cboe.quotes',
  'cboe.options',
  'cboe.symbolBook',
  'cboe.euIndices',
  'yahoo.chart',
  'yahoo.search',
  'openfigi.mapping',
  'sec.tickers',
  'sec.submissions',
  'sec.companyfacts',
  'sec.frames',
  'sec.atom',
  'sec.archives',
  'fred.csv',
  'fred.calendar',
  'nyfed.rates',
  'fed.h15',
  'fed.rss',
  'fed.fomc',
  'treasury.yieldcurve',
  'treasury.bills',
  'bls.timeseries',
  'bls.schedule',
  'worldbank',
  'imf.datamapper',
  'frankfurter',
  'finra.shortInterest',
  'bbg.rss',
  'coingecko.simple',
  'ssga.holdings',
] as const;

/** A provider adapter id. Every `ProviderId` is also a `licence_registry.source_id`. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

const PROVIDER_ID_SET: ReadonlySet<string> = new Set<string>(PROVIDER_IDS);

/** Narrowing guard for strings that arrive from JSON (`manifest.json`, job parameters, the API). */
export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_ID_SET.has(value);
}

/**
 * A source id a captured exchange may carry: every adapter id, plus the non-adapter sources whose
 * bytes were nevertheless captured over HTTP by hand. **Addition to PROVIDERS.a §1.1 (§18), forced
 * by the committed fixtures:** `fixtures/providers/manifest.json` holds a `wiki.sp500` capture
 * (`wiki-sp500.html`, the only source of GICS sector names for S&P 500 issuers — WORKPLAN WP-04),
 * which WP-04's `refdata/classifications.ts` reads through the same replay store as every adapter.
 * `provenance.source_id` accepts any `licence_registry` row, so the record type has to be able to
 * name one. An adapter's own `fetch` still returns records whose `providerId` is its `ProviderId`.
 */
export type CaptureSourceId = ProviderId | NonAdapterSourceId;

const CAPTURE_SOURCE_ID_SET: ReadonlySet<string> = new Set<string>([
  ...PROVIDER_IDS,
  ...NON_ADAPTER_SOURCE_IDS,
]);

/** Narrowing guard for the source id on a manifest entry. */
export function isCaptureSourceId(value: string): value is CaptureSourceId {
  return CAPTURE_SOURCE_ID_SET.has(value);
}

/**
 * `PROVIDER_IDS` ∪ `NON_ADAPTER_SOURCE_IDS` must be exactly `licenceSourceIds`. Called once, at
 * module load: a mismatch means either an adapter whose licence row is missing (every write it
 * makes would be rejected by `assert_source_known` at runtime, DATA-09) or a source that gained an
 * adapter without gaining an id here. Both are startup failures, not warnings.
 *
 * @throws Error naming the ids on each side of the difference.
 */
export function assertProviderIdsMatchLicences(): void {
  const declared = new Set<string>([...PROVIDER_IDS, ...NON_ADAPTER_SOURCE_IDS]);
  const registered = new Set<string>(licenceSourceIds);

  const missingLicence = [...declared].filter((id) => !registered.has(id)).sort();
  const missingAdapter = [...registered].filter((id) => !declared.has(id)).sort();

  if (missingLicence.length > 0 || missingAdapter.length > 0) {
    const parts: string[] = [];
    if (missingLicence.length > 0) {
      parts.push(
        `declared here but absent from licence_registry: ${missingLicence.join(', ')} ` +
          '(assert_source_known would reject every provenance row)',
      );
    }
    if (missingAdapter.length > 0) {
      parts.push(
        `in licence_registry but neither a ProviderId nor a NON_ADAPTER_SOURCE_ID: ` +
          `${missingAdapter.join(', ')}`,
      );
    }
    throw new Error(
      `providers/types.ts is out of step with providers/licences.ts — ${parts.join('; ')}`,
    );
  }

  if (PROVIDER_ID_SET.size !== PROVIDER_IDS.length) {
    throw new Error('PROVIDER_IDS contains a duplicate id');
  }
}

assertProviderIdsMatchLicences();

/** `true` when `sourceId` is a known `licence_registry` row (adapter or not) — DATA-09. */
export function isLicensedSource(sourceId: string): boolean {
  return isKnownSourceId(sourceId);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// RawRecord — the one thing the replay store persists and the only input to normalise()
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One raw provider exchange. Immutable. Shape extends ARCHITECTURE §6.2
 * `{ url, status, headers, body, capturedAt, sha256 }` with everything provenance needs, so
 * `insertProvenance(tx, raw, …)` never has to reach back to the caller for a field.
 */
export interface RawRecord {
  /** Usually a `ProviderId`; widened for the hand-captured non-adapter sources (see above). */
  readonly providerId: CaptureSourceId;
  readonly method: HttpMethod;
  /** Canonical URL (scheme + host + path + sorted query), post-redirect — `canonicalUrl()`. */
  readonly url: string;
  /** `replayStore.requestKey(...)` → `provenance.request_key`. */
  readonly requestKey: string;
  /** Lower-case hex `sha256(method + url + body)` → `provenance.request_hash`. */
  readonly requestHash: string;
  /** `200 | 304 | …` → `provenance.http_status`. */
  readonly status: number;
  /** Lower-cased header names; `etag`, `last-modified` and `content-type` are always kept. */
  readonly headers: Readonly<Record<string, string>>;
  /** The exact bytes, never a parsed object. `provenance.bytes` is `body.length`. */
  readonly body: Buffer;
  /** Epoch ms — FEED-05 `cap`, `provenance.captured_at`, and the only clock a normaliser sees. */
  readonly capturedAt: number;
  /** Lower-case hex of `body` → `provenance.response_sha256`; verified on every fixture load. */
  readonly sha256: string;
  /**
   * The provider-published instant when the transport already knows it (the replay store reads it
   * from `manifest.json`), else `null`. **Addition to PROVIDERS.a §1.1 (§18).** A normaliser may
   * still publish a more precise `Normalised.sourceTs` — `insertProvenance` takes the meta value
   * when one is given and falls back to this.
   */
  readonly sourceTs: Date | null;
  /** `'cache'` = a 304 revalidation or TTL hit whose body came from the store (PROVIDERS.a §2.4). */
  readonly origin: RawRecordOrigin;
}

export type RawRecordOrigin = 'live' | 'cache' | 'replay';

export type HttpMethod = 'GET' | 'POST';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Normalise
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a normaliser returns: plant-bound updates plus typed rows bound for Postgres. `Rows` is a
 * per-adapter record of arrays; an adapter that only ticks the plant sets `Rows = {}`.
 */
export interface Normalised<Rows> {
  /** `plant.apply()` input, one per md line touched. */
  updates: NormalisedUpdate[];
  /** Typed row objects; property names are the DATA_MODEL.md column names, camel-cased. */
  rows: Rows;
  /** `provenance.source_ts` — the provider-published instant ('src'), `null` when none. */
  sourceTs: Date | null;
  /** Non-fatal: unknown symbol, dropped field, schema drift. A normaliser never throws (§1.2). */
  problems: NormaliseProblem[];
}

export interface NormaliseProblem {
  kind: NormaliseProblemKind;
  detail: string;
  /** JSON pointer into the payload, e.g. `/data/options/17/iv`. */
  path?: string;
}

export type NormaliseProblemKind =
  'parse_error' | 'unknown_symbol' | 'field_dropped' | 'schema_drift' | 'out_of_range';

/** One md line, as `NormaliseContext` exposes it. Keyed by `md_lines.provider_symbol`. */
export interface NormaliseLine {
  mdLineId: number;
  instrumentId: number;
  assetClass: AssetClass;
  tier: Tier;
  intrinsicDelayMin: number;
  expectedIntervalMs: number;
  priority: number;
}

/**
 * Everything `normalise()` is allowed to know. No db handle, no network, no `Date.now()` — the
 * purity rules of PROVIDERS.a §1.2 are what make the golden files in
 * `fixtures/providers/normalised/` meaningful and the QA-05 fuzzers possible.
 */
export interface NormaliseContext {
  /** From `providers/provenance.ts`, inserted *before* `normalise()` runs (§1.3 step 4). */
  provenanceId: number;
  /** `= raw.capturedAt`; the only clock reading a normaliser sees. */
  capturedAt: number;
  /** md lines already resolved for this source: key = `md_lines.provider_symbol`. */
  lines: ReadonlyMap<string, NormaliseLine>;
  /** Instrument ids for symbols the adapter may mint rows for (option contracts, fx pairs). */
  resolveInstrument?(key: { scheme: IdScheme; value: string; qualifier: string }): number | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The HTTP client seen by an adapter (PROVIDERS.a §2, L228-250)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface HttpRequest {
  providerId: ProviderId;
  /** Default `'GET'`. */
  method?: HttpMethod;
  url: string;
  /** Merged over the per-provider defaults of PROVIDERS.a §2.2. */
  headers?: Record<string, string>;
  /** POST only (OpenFIGI). Participates in the request key byte for byte. */
  body?: string;
  /** `0` = always revalidate; `> 0` = serve from the store without a request (§2.4). */
  cacheTtlMs?: number;
  /** Default per provider (§2.2). */
  timeoutMs?: number;
  /** OPS-07 — copied onto `provenance.trace_id`. */
  traceId?: string;
  /** `ingest_runs.run_id` when the scheduler is the caller. */
  runId?: number;
  /** The scheduler may consume at most 70 % of a bucket (§2.2). Default `'scheduler'`. */
  budgetShare?: 'scheduler' | 'interactive';
  /** Replay only: walk a request through successive captures of the same key (§3.3). */
  captureIndex?: number;
}

export interface BreakerState {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openedAt: number | null;
}

export interface BucketState {
  capacity: number;
  available: number;
  refillPerSec: number;
}

/**
 * The shared client, one per process, injected into every adapter. Implemented by
 * `providers/http.ts` (WP-05); declared here so `ProviderAdapter` can name it.
 */
export interface HttpClient {
  readonly mode: ProviderMode;
  get(req: HttpRequest): Promise<RawRecord>;
  post(req: HttpRequest & { body: string }): Promise<RawRecord>;
  breaker(id: ProviderId): BreakerState;
  tokens(id: ProviderId): BucketState;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ProviderAdapter
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The fetch / normalise split is mandatory (PROVIDERS.a §1.2): `fetch` is the only impure half,
 * `normalise` is a pure function of `(bytes, context)` — the thing the fuzzers hit and the goldens
 * pin, and the thing that must produce identical output on a 2026 laptop and a 2030 CI box.
 */
export interface ProviderAdapter<Req, Rows> {
  readonly id: ProviderId;
  /** `licence_registry.source_id` — equal to `id` for every v1 adapter (DATA-09). */
  readonly sourceId: string;
  /** `provenance.adapter_version`, `'<family>/<semver>'` — e.g. `'cboe/1.0.0'` (§1.4). */
  readonly adapterVersion: string;
  /** Build URL + headers and go through `http.ts`. Never parses. Never writes. */
  fetch(http: HttpClient, req: Req): Promise<RawRecord>;
  /** Pure: `(RawRecord, NormaliseContext) → rows`. Same input ⇒ byte-identical output, forever. */
  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<Rows>;
}

/**
 * An adapter of unknown request and row types — what the registry stores. `never` in the request
 * position and `unknown` in the row position, rather than `any`: method parameters are bivariant,
 * so every concrete `ProviderAdapter<Req, Rows>` is assignable to this, and nothing unsafe leaks
 * out of a lookup the way `any` would.
 */
export type AnyProviderAdapter = ProviderAdapter<never, unknown>;
