/**
 * `symbologyRefresh` — OpenFIGI `/v3/mapping` + the SEC ticker file → master rows.
 * PROVIDERS §13 (job table), §6.1 (`openfigi.mapping`), §7.1 (`sec.tickers`),
 * ARCHITECTURE §7.1, WORKPLAN §WP-04 L705.
 *
 * The job that gives a ticker an identity. It answers one question per target ticker — "what is
 * this, and what FIGIs does the world know it by" — and writes the answer through the bitemporal
 * repositories of `refdata/master.ts` and `refdata/identifiers.ts`, every write an `upsertVersion`
 * so the daily refresh of an unchanged universe writes **zero** versions (QA-02).
 *
 * ## What it writes, and what it deliberately does not
 *
 * `issuers`, `issues`, `instruments`, `listings`, `identifiers` (ARCHITECTURE §7.1). No
 * `md_lines`: the quote lines are the seed's (`md_lines_symbol_excl` allows exactly one writer per
 * `(source_id, provider_symbol)`, WORKPLAN L714-722), and OpenFIGI publishes no market data.
 *
 * Three fields are read from the master and written back unchanged when the row already exists,
 * because another writer owns them and a daily fight over them would grow a new version per day
 * for no new information:
 *
 *  * `instruments.name` — owned by `universeSymbolBook` (the Cboe description) and by the seed.
 *    OpenFIGI's `name` is the *issue* name (`'APPLE INC'`), and that is where it is written.
 *  * `instruments.search_weight` and `instruments.status` — owned by the universe merge
 *    (`refdata/universe.ts`) and by index membership.
 *  * `listings.is_primary` / `instruments.primary_listing_id` — OpenFIGI publishes no primary-venue
 *    flag, so this job never claims one. A new listing is written with `is_primary false` and the
 *    instrument's `primary_listing_id` is left as it was found (`NULL` for a row this job created).
 *
 * ## US composites only
 *
 * One `instruments` row per **composite** FIGI (§6.1), and this job mints only the `exchCode 'US'`
 * composite. The recorded fixture answers `[{TICKER,AAPL,US},{TICKER,AAPL}]` and the second job
 * returns 98 composites across 90-odd venues — Mexican, German, Swiss lines whose `currency` the
 * mapping payload does not publish. `issues.currency` and `instruments.currency` are `NOT NULL`,
 * and inventing `'USD'` for an `AAPLEUR` line on a Frankfurt venue would be a fabricated value on a
 * reference row. Those composites are counted in `counts.deferredNonUs` and left to the venue
 * adapters. Venue *listings* under the US composite carry no currency and are all written.
 *
 * ## Time
 *
 * `valid_from` is the instant the payload was published (`source_ts`, else the capture instant):
 * the fact is true in the world from then. `tx_from` (`knownAt`) is the job's own clock — when
 * *we* learned it — which is what keeps a second run idempotent: the reads that look for the rows
 * of the previous run are taken at the same `knownAt`, and `upsertVersion` then finds the current
 * version, compares it column by column and returns `null`.
 *
 * ## Fetching
 *
 * `ctx.http` (WP-05's `providers/http.ts`) when the scheduler injects one; the replay store
 * otherwise, which is what makes `npm run db:seed` and the QA-02 test work offline against the
 * recorded captures. The `ProviderRegistry` supplies `adapter_version` for the provenance row when
 * the adapters are registered, and the module constants below are the fallback.
 *
 * **Deviation from PROVIDERS §6.1 (§18):** §6.1 says `normalise` "re-reads the jobs from
 * `raw.body`". `RawRecord.body` is the *response*; the request body is not carried on the record
 * (it lives in the replay manifest). `parseOpenFigiMapping` therefore takes the job array from the
 * caller that built it, and still refuses the payload when `elements.length !== jobs.length` —
 * the positional-parallelism rule §6.1 calls the most important in the adapter.
 */

import { sql } from 'drizzle-orm';

import { SystemClock, padCik } from '@terminal/core';
import type { AssetClass, Clock, MarketSector } from '@terminal/core';

import type { AsOf } from '../../db/bitemporal.js';
import { withTx } from '../../db/client.js';
import type { Db, Tx } from '../../db/client.js';
import { dataExceptions, dqEvents } from '../../db/schema/index.js';
import { insertProvenance } from '../../providers/provenance.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { openReplayStore } from '../../providers/replayStore.js';
import type { ReplayStore } from '../../providers/replayStore.js';
import type {
  HttpClient,
  HttpMethod,
  HttpRequest,
  NormaliseProblem,
  ProviderId,
  RawRecord,
} from '../../providers/types.js';
import { IdentifierRepository } from '../../refdata/identifiers.js';
import {
  MasterRepositories,
  toInstrumentInput,
  toIssuerInput,
  toIssueInput,
  toListingInput,
} from '../../refdata/master.js';
import type {
  InstrumentInput,
  IssuerInput,
  IssueInput,
  ListingInput,
  WriteOptions,
} from '../../refdata/master.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants — PROVIDERS §13, §6.1, §7.1
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `IngestJob.id` = the module basename = `ingest_runs.job_id` (PROVIDERS §13). */
export const SYMBOLOGY_REFRESH_JOB_ID = 'symbologyRefresh';

/** PROVIDERS §13: daily 06:00 ET on weekdays, plus on demand. */
export const SYMBOLOGY_REFRESH_SCHEDULE = '0 6 * * 1-5';

/** PROVIDERS §13. */
export const SYMBOLOGY_REFRESH_TIMEOUT_MS = 600_000;

export const OPENFIGI_MAPPING_URL = 'https://api.openfigi.com/v3/mapping';

export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/** `provenance.adapter_version` when the registry holds no adapter yet (PROVIDERS §1.4). */
export const OPENFIGI_ADAPTER_VERSION = 'openfigi/1.0.0';

export const SEC_TICKERS_ADAPTER_VERSION = 'sec/1.0.0';

/** PROVIDERS §7.1: SEC rewrites `company_tickers.json` daily; a 6 h TTL never serves a stale day. */
export const SEC_TICKERS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** PROVIDERS §7.1 — fewer entries than this is a truncated file, not a smaller universe. */
export const MIN_SEC_TICKER_ENTRIES = 8_000;

/** The recorded capture's entry count — `dq_events.details.expected`. */
export const EXPECTED_SEC_TICKER_ENTRIES = 10_422;

/** PROVIDERS §6.1: 1-10 jobs per request keyless; `OPENFIGI_JOBS_PER_REQUEST` raises it to 100. */
export const DEFAULT_JOBS_PER_REQUEST = 10;

/** Two jobs per ticker: the `US` composite, and the bare ticker for the global lines. */
export const JOBS_PER_TICKER = 2;

/** How many unresolved tickers one scheduled run takes when the caller names none. */
export const DEFAULT_MAX_TICKERS = 200;

/** The one composite this job mints master rows for. See the module comment. */
export const COMPOSITE_EXCH_CODE = 'US';

/** `issues.currency` / `instruments.currency` for a `US` composite. */
const US_CURRENCY = 'USD';

/** Beyond this many parse problems the run reports a count instead of a list. */
const MAX_REPORTED_PROBLEMS = 50;

/**
 * OpenFIGI `securityType` → `asset_class` (PROVIDERS §6.1, the `asset_class` row: "derived, not
 * published"). Anything absent from this table is a security type this system has no home for; the
 * record is dropped with a `field_dropped` problem rather than filed under a guess.
 */
const ASSET_CLASS_BY_SECURITY_TYPE: ReadonlyMap<string, AssetClass> = new Map<string, AssetClass>([
  ['COMMON STOCK', 'equity'],
  ['REIT', 'equity'],
  ['PREFERENCE', 'equity'],
  ['PREFERRED', 'equity'],
  ['ETP', 'etf'],
  ['MUTUAL FUND', 'etf'],
  ['INDEX', 'index'],
  ['US GOVERNMENT', 'govt'],
  ['EQUITY OPTION', 'option'],
  ['SPOT', 'fx'],
]);

/** `market_sector` (CONTRACTS §1.1) — OpenFIGI's own values, which is why they need no re-coding. */
const MARKET_SECTORS: ReadonlySet<string> = new Set<string>([
  'Equity',
  'Index',
  'Curncy',
  'Govt',
  'Corp',
  'Comdty',
  'Mtge',
  'Muni',
  'Pfd',
  'M-Mkt',
  'Crypto',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One element of the OpenFIGI request array (PROVIDERS §6.1). */
export interface OpenFigiJob {
  idType: 'TICKER' | 'ID_CUSIP' | 'ID_ISIN';
  idValue: string;
  exchCode?: string;
}

/** One `data[]` record of the response. */
export interface OpenFigiRecord {
  figi: string;
  name: string;
  ticker: string;
  exchCode: string;
  compositeFIGI: string;
  securityType: string;
  marketSector: string;
  shareClassFIGI?: string;
  securityType2?: string;
  securityDescription?: string;
}

/** One element of the response array: data, a warning, or an error — never two of them. */
export type OpenFigiElement =
  | { kind: 'data'; records: OpenFigiRecord[] }
  | { kind: 'warning'; text: string }
  | { kind: 'error'; text: string };

/** One entry of SEC `company_tickers.json`, CIK already zero-padded to ten. */
export interface SecTickerEntry {
  cik: string;
  ticker: string;
  title: string;
}

export interface SecTickerParse {
  entries: SecTickerEntry[];
  problems: NormaliseProblem[];
}

export interface OpenFigiParse {
  elements: OpenFigiElement[];
  problems: NormaliseProblem[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pure parsing
// ─────────────────────────────────────────────────────────────────────────────────────────────

function textOf(body: Buffer | string): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * SEC `company_tickers.json` → entries, in the payload's own numeric key order (PROVIDERS §7.1:
 * the keys are decimal strings and `"10" < "9"` under string ordering, which would shuffle the
 * output and break every golden that depends on it).
 *
 * Never throws: a malformed payload comes back as zero entries and a `parse_error` problem.
 */
export function parseSecTickers(body: Buffer | string): SecTickerParse {
  const problems: NormaliseProblem[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(textOf(body));
  } catch (err) {
    return {
      entries: [],
      problems: [{ kind: 'parse_error', detail: `company_tickers.json: ${messageOf(err)}` }],
    };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      entries: [],
      problems: [
        {
          kind: 'schema_drift',
          detail: 'company_tickers.json is not a JSON object keyed by decimal strings',
        },
      ],
    };
  }

  const record = doc as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b));

  const entries: SecTickerEntry[] = [];
  let dropped = 0;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'object' || value === null) {
      dropped += 1;
      continue;
    }
    const row = value as { cik_str?: unknown; ticker?: unknown; title?: unknown };
    const cik =
      typeof row.cik_str === 'number' || typeof row.cik_str === 'string'
        ? padCik(row.cik_str)
        : null;
    const ticker = typeof row.ticker === 'string' ? row.ticker.trim().toUpperCase() : '';
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (cik === null || ticker === '' || title === '') {
      dropped += 1;
      if (problems.length < MAX_REPORTED_PROBLEMS) {
        problems.push({
          kind: 'field_dropped',
          detail: `company_tickers.json[${key}] is not a {cik_str, ticker, title} row`,
          path: `/${key}`,
        });
      }
      continue;
    }
    entries.push({ cik, ticker, title });
  }
  if (dropped > problems.length) {
    problems.push({
      kind: 'field_dropped',
      detail: `${String(dropped)} company_tickers.json entries were unusable`,
    });
  }
  return { entries, problems };
}

/** `{byTicker, byCik, conflicts}` — one issuer per CIK, a ticker claimed twice is a conflict. */
export interface SecTickerIndex {
  byTicker: Map<string, SecTickerEntry>;
  byCik: Map<string, SecTickerEntry[]>;
  /** Tickers that appear under more than one CIK (PROVIDERS §7.1: `source_conflict`). */
  conflicts: string[];
}

export function indexSecTickers(entries: readonly SecTickerEntry[]): SecTickerIndex {
  const byTicker = new Map<string, SecTickerEntry>();
  const byCik = new Map<string, SecTickerEntry[]>();
  const conflicting = new Set<string>();
  for (const entry of entries) {
    const seen = byTicker.get(entry.ticker);
    if (seen === undefined) byTicker.set(entry.ticker, entry);
    else if (seen.cik !== entry.cik) conflicting.add(entry.ticker);
    const group = byCik.get(entry.cik);
    if (group === undefined) byCik.set(entry.cik, [entry]);
    else group.push(entry);
  }
  // A ticker under two CIKs identifies nothing: drop the join and let data ops decide (§7.1).
  for (const ticker of conflicting) byTicker.delete(ticker);
  return { byTicker, byCik, conflicts: [...conflicting].sort() };
}

/**
 * The job array for a batch of tickers: the `US` composite and the bare ticker, per PROVIDERS §6.1
 * and the recorded capture. Sorted by `(idType, idValue, exchCode)` with an absent `exchCode` last
 * — the body is part of the `requestKey` (§3.2), so an unsorted list would miss every capture.
 */
export function openFigiJobsFor(tickers: readonly string[]): OpenFigiJob[] {
  const jobs: OpenFigiJob[] = [];
  for (const raw of tickers) {
    const ticker = raw.trim().toUpperCase();
    if (ticker === '') continue;
    jobs.push({ idType: 'TICKER', idValue: ticker, exchCode: COMPOSITE_EXCH_CODE });
    jobs.push({ idType: 'TICKER', idValue: ticker });
  }
  return sortOpenFigiJobs(jobs);
}

/** PROVIDERS §6.1 step 1. `'￿'` sorts an absent `exchCode` after every present one. */
export function sortOpenFigiJobs(jobs: readonly OpenFigiJob[]): OpenFigiJob[] {
  return [...jobs].sort((a, b) => {
    if (a.idType !== b.idType) return a.idType < b.idType ? -1 : 1;
    if (a.idValue !== b.idValue) return a.idValue < b.idValue ? -1 : 1;
    const ax = a.exchCode ?? '￿';
    const bx = b.exchCode ?? '￿';
    return ax === bx ? 0 : ax < bx ? -1 : 1;
  });
}

/** Slice a sorted job list into request-sized groups; the last group may be short (§6.1). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const width = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += width) out.push(items.slice(i, i + width));
  return out;
}

/** The exact request body: `JSON.stringify` with no whitespace (PROVIDERS §6.1). */
export function openFigiBody(jobs: readonly OpenFigiJob[]): string {
  return JSON.stringify(jobs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The mapping response, positionally parallel to `jobs` (PROVIDERS §6.1). A length mismatch drops
 * the **whole** payload with a `schema_drift` problem: element *i* is the only thing that says
 * which job a record answers, so a shifted array silently files every row under the wrong ticker.
 */
export function parseOpenFigiMapping(
  body: Buffer | string,
  jobs: readonly OpenFigiJob[],
): OpenFigiParse {
  let doc: unknown;
  try {
    doc = JSON.parse(textOf(body));
  } catch (err) {
    return { elements: [], problems: [{ kind: 'parse_error', detail: messageOf(err) }] };
  }
  if (!Array.isArray(doc)) {
    return {
      elements: [],
      problems: [{ kind: 'schema_drift', detail: 'openfigi /v3/mapping did not return an array' }],
    };
  }
  if (doc.length !== jobs.length) {
    return {
      elements: [],
      problems: [
        {
          kind: 'schema_drift',
          detail:
            `openfigi /v3/mapping answered ${String(doc.length)} elements for ` +
            `${String(jobs.length)} jobs; the response is positional, so the whole payload is dropped`,
        },
      ],
    };
  }

  const problems: NormaliseProblem[] = [];
  const elements: OpenFigiElement[] = [];
  doc.forEach((raw, index) => {
    if (!isRecord(raw)) {
      elements.push({ kind: 'error', text: 'element is not an object' });
      problems.push({
        kind: 'schema_drift',
        detail: 'openfigi element is not an object',
        path: `/${String(index)}`,
      });
      return;
    }
    const error = stringField(raw, 'error');
    if (error !== undefined) {
      elements.push({ kind: 'error', text: error });
      return;
    }
    const warning = stringField(raw, 'warning');
    if (warning !== undefined) {
      elements.push({ kind: 'warning', text: warning });
      return;
    }
    const data = raw.data;
    if (!Array.isArray(data)) {
      elements.push({ kind: 'error', text: 'element carries neither data, warning nor error' });
      problems.push({
        kind: 'schema_drift',
        detail: 'openfigi element carries neither data, warning nor error',
        path: `/${String(index)}`,
      });
      return;
    }
    const records: OpenFigiRecord[] = [];
    data.forEach((entry, position) => {
      if (!isRecord(entry)) return;
      const figi = stringField(entry, 'figi');
      const ticker = stringField(entry, 'ticker');
      const exchCode = stringField(entry, 'exchCode');
      const compositeFigi = stringField(entry, 'compositeFIGI');
      const securityType = stringField(entry, 'securityType');
      const marketSector = stringField(entry, 'marketSector');
      const name = stringField(entry, 'name');
      if (
        figi === undefined ||
        ticker === undefined ||
        exchCode === undefined ||
        compositeFigi === undefined ||
        securityType === undefined ||
        marketSector === undefined ||
        name === undefined
      ) {
        if (problems.length < MAX_REPORTED_PROBLEMS) {
          problems.push({
            kind: 'field_dropped',
            detail: 'openfigi record is missing one of figi/ticker/exchCode/compositeFIGI/name',
            path: `/${String(index)}/data/${String(position)}`,
          });
        }
        return;
      }
      const record: OpenFigiRecord = {
        figi: figi.toUpperCase(),
        name,
        ticker: ticker.toUpperCase(),
        exchCode: exchCode.toUpperCase(),
        compositeFIGI: compositeFigi.toUpperCase(),
        securityType,
        marketSector,
      };
      const shareClassFigi = stringField(entry, 'shareClassFIGI');
      if (shareClassFigi !== undefined) record.shareClassFIGI = shareClassFigi.toUpperCase();
      const securityType2 = stringField(entry, 'securityType2');
      if (securityType2 !== undefined) record.securityType2 = securityType2;
      const securityDescription = stringField(entry, 'securityDescription');
      if (securityDescription !== undefined) record.securityDescription = securityDescription;
      records.push(record);
    });
    elements.push({ kind: 'data', records });
  });

  return { elements, problems };
}

/** PROVIDERS §6.1, the `asset_class` row. `null` = a security type with no home here. */
export function assetClassForSecurityType(securityType: string): AssetClass | null {
  return ASSET_CLASS_BY_SECURITY_TYPE.get(securityType.trim().toUpperCase()) ?? null;
}

function marketSectorOf(value: string): MarketSector | null {
  return MARKET_SECTORS.has(value) ? (value as MarketSector) : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Job context and result
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `ingest_runs.errors` — `JobError[]` (CONTRACTS §1.2). */
export interface JobError {
  code: string;
  message: string;
  url?: string;
  requestKey?: string;
}

/**
 * What the job needs. Every field is optional, so the scheduler's `JobContext`
 * (`{clock, db, providers, plant, hotset, traceId, log}`, ARCHITECTURE L994) satisfies it
 * structurally and WP-05 needs no adapter shim.
 */
export interface SymbologyRefreshContext {
  /** Run inside this transaction. Omitted → `withTx(null, …)`, which joins an ambient one. */
  tx?: Tx;
  db?: Db;
  clock?: Clock;
  providers?: ProviderRegistry;
  /** WP-05's client. Omitted → the replay store, which is how `db:seed` runs offline. */
  http?: HttpClient;
  store?: ReplayStore;
  traceId?: string;
  runId?: number;
}

export interface SymbologyRefreshOptions {
  /** The target set. Omitted → the unresolved tickers of the SEC file (PROVIDERS §6.1 step 3). */
  tickers?: readonly string[];
  /** Cap on a derived target set. */
  maxTickers?: number;
  /** OpenFIGI jobs per request: 10 keyless, 100 with a key (`OPENFIGI_JOBS_PER_REQUEST`). */
  jobsPerRequest?: number;
}

export interface SymbologyRefreshCounts {
  secEntries: number;
  requests: number;
  /** Distinct `figi` records across every element. */
  records: number;
  issuers: number;
  issues: number;
  instruments: number;
  listings: number;
  identifiers: number;
  /** Composites outside `exchCode 'US'` — see the module comment. */
  deferredNonUs: number;
  /** Composites whose own composite record was not in this payload. */
  deferredNoComposite: number;
  /** `{"error": "No identifier found."}` elements. */
  unresolved: number;
}

export interface SymbologyRefreshResult {
  jobId: typeof SYMBOLOGY_REFRESH_JOB_ID;
  status: 'ok' | 'skipped' | 'failed';
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: JobError[];
  provenanceIds: number[];
  problems: NormaliseProblem[];
  /** The target tickers this run actually asked about. */
  tickers: string[];
  counts: SymbologyRefreshCounts;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface FetchSpec {
  providerId: ProviderId;
  method: HttpMethod;
  url: string;
  body?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
}

function fetchRaw(ctx: SymbologyRefreshContext, spec: FetchSpec): Promise<RawRecord> {
  const http = ctx.http;
  if (http !== undefined) {
    const req: HttpRequest = {
      providerId: spec.providerId,
      method: spec.method,
      url: spec.url,
      budgetShare: 'scheduler',
    };
    if (spec.cacheTtlMs !== undefined) req.cacheTtlMs = spec.cacheTtlMs;
    if (spec.timeoutMs !== undefined) req.timeoutMs = spec.timeoutMs;
    if (ctx.traceId !== undefined) req.traceId = ctx.traceId;
    if (ctx.runId !== undefined) req.runId = ctx.runId;
    if (spec.method === 'POST') return http.post({ ...req, body: spec.body ?? '' });
    return http.get(req);
  }
  const store = ctx.store ?? openReplayStore();
  const replay: { providerId: ProviderId; method: HttpMethod; url: string; body?: string } = {
    providerId: spec.providerId,
    method: spec.method,
    url: spec.url,
  };
  if (spec.body !== undefined) replay.body = spec.body;
  return Promise.resolve(store.replay(replay));
}

/** The adapter's own version when it is registered, the module constant otherwise. */
function adapterVersion(
  providers: ProviderRegistry | undefined,
  id: ProviderId,
  fallback: string,
): string {
  return providers?.get(id)?.adapterVersion ?? fallback;
}

/** `valid_from`: the instant the payload was published, else the instant it was captured. */
function publishedAt(raw: RawRecord): Date {
  return raw.sourceTs ?? new Date(raw.capturedAt);
}

async function writeProvenance(
  tx: Tx,
  ctx: SymbologyRefreshContext,
  raw: RawRecord,
  version: string,
): Promise<number> {
  const meta: { adapterVersion: string; traceId?: string; runId?: number } = {
    adapterVersion: version,
  };
  if (ctx.traceId !== undefined) meta.traceId = ctx.traceId;
  if (ctx.runId !== undefined) meta.runId = ctx.runId;
  return insertProvenance(tx, raw, meta);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Ops rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function raiseDqEvent(
  tx: Tx,
  row: {
    kind: string;
    severity: 'info' | 'warn' | 'error';
    sourceId: string;
    subject: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(dqEvents).values({
    kind: row.kind,
    severity: row.severity,
    sourceId: row.sourceId,
    subject: row.subject,
    details: row.details,
  });
}

async function openException(
  tx: Tx,
  row: {
    kind: string;
    entityKind: 'issuer' | 'issue' | 'instrument' | 'listing';
    field: string;
    candidates: { sourceId: string; provenanceId: number; value: string }[];
  },
): Promise<void> {
  await tx.insert(dataExceptions).values({
    kind: row.kind,
    entityKind: row.entityKind,
    field: row.field,
    candidates: row.candidates,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run the job.
 *
 * @param ctx transaction / clock / transport. `ctx.tx` is used when given, otherwise the job opens
 *            its own `withTx(null, …)` — which nests as a SAVEPOINT inside a test transaction.
 * @param options the target set and batching; every field has a documented default.
 */
export async function runSymbologyRefresh(
  ctx: SymbologyRefreshContext = {},
  options: SymbologyRefreshOptions = {},
): Promise<SymbologyRefreshResult> {
  if (ctx.tx !== undefined) return execute(ctx.tx, ctx, options);
  return withTx(null, (tx) => execute(tx, ctx, options));
}

/** Tickers of the SEC file with no current `US` composite in the master (PROVIDERS §6.1 step 3). */
async function selectUnresolvedTickers(
  tx: Tx,
  tickers: readonly string[],
  at: AsOf,
  limit: number,
): Promise<string[]> {
  if (tickers.length === 0 || limit <= 0) return [];
  const rows = await tx.execute<{ ticker: string }>(
    // `sql.param` keeps the array ONE bind parameter: a bare array inside a drizzle template is
    // expanded to `(a, b, c)`, which is not a `text[]`.
    sql`
      SELECT t.ticker
        FROM unnest(${sql.param([...tickers])}::text[]) AS t(ticker)
       WHERE NOT EXISTS (
               SELECT 1
                 FROM instruments i
                WHERE upper(i.ticker) = t.ticker
                  AND i.exch_code = ${COMPOSITE_EXCH_CODE}
                  AND i.composite_figi IS NOT NULL
                  AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                               ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz))
       ORDER BY t.ticker
       LIMIT ${limit}`,
  );
  return rows.rows.map((row) => row.ticker);
}

interface Tally {
  inserted: number;
  updated: number;
  skipped: number;
}

function tallyWrite(tally: Tally, versionId: number | null, created: boolean): void {
  if (versionId === null) tally.skipped += 1;
  else if (created) tally.inserted += 1;
  else tally.updated += 1;
}

async function execute(
  tx: Tx,
  ctx: SymbologyRefreshContext,
  options: SymbologyRefreshOptions,
): Promise<SymbologyRefreshResult> {
  const clock = ctx.clock ?? new SystemClock();
  const knownAt = new Date(clock.now());
  const problems: NormaliseProblem[] = [];
  const errors: JobError[] = [];
  const provenanceIds: number[] = [];
  const tally: Tally = { inserted: 0, updated: 0, skipped: 0 };
  const counts: SymbologyRefreshCounts = {
    secEntries: 0,
    requests: 0,
    records: 0,
    issuers: 0,
    issues: 0,
    instruments: 0,
    listings: 0,
    identifiers: 0,
    deferredNonUs: 0,
    deferredNoComposite: 0,
    unresolved: 0,
  };
  let fetched = 0;

  const result = (
    status: SymbologyRefreshResult['status'],
    tickers: string[],
  ): SymbologyRefreshResult => ({
    jobId: SYMBOLOGY_REFRESH_JOB_ID,
    status,
    fetched,
    inserted: tally.inserted,
    updated: tally.updated,
    skipped: tally.skipped,
    errors,
    provenanceIds,
    problems,
    tickers,
    counts,
  });

  // ── 1. the SEC ticker file ────────────────────────────────────────────────────────────────
  const secRaw = await fetchRaw(ctx, {
    providerId: 'sec.tickers',
    method: 'GET',
    url: SEC_TICKERS_URL,
    cacheTtlMs: SEC_TICKERS_CACHE_TTL_MS,
  });
  fetched += 1;

  // PROVIDERS §1.3: a 304 publishes nothing new — no provenance row, no work, counted in
  // `ingest_runs.skipped`. The SEC file is the ticker → CIK join every write below depends on, so
  // an unchanged file means an unchanged master.
  if (secRaw.status === 304) {
    tally.skipped += 1;
    return result('skipped', []);
  }

  const sec = parseSecTickers(secRaw.body);
  problems.push(...sec.problems);
  counts.secEntries = sec.entries.length;

  if (sec.entries.length < MIN_SEC_TICKER_ENTRIES) {
    // PROVIDERS §7.1: a truncated file would quietly retire half the universe. Nothing is written.
    await raiseDqEvent(tx, {
      kind: 'poll_anomaly',
      severity: 'error',
      sourceId: 'sec.tickers',
      subject: 'company_tickers.json',
      details: { expected: EXPECTED_SEC_TICKER_ENTRIES, actual: sec.entries.length },
    });
    errors.push({
      code: 'POLL_ANOMALY',
      message:
        `company_tickers.json carried ${String(sec.entries.length)} entries, fewer than the ` +
        `${String(MIN_SEC_TICKER_ENTRIES)} floor; the previous master stands`,
      url: SEC_TICKERS_URL,
      requestKey: secRaw.requestKey,
    });
    return result('skipped', []);
  }

  const secProvenanceId = await writeProvenance(
    tx,
    ctx,
    secRaw,
    adapterVersion(ctx.providers, 'sec.tickers', SEC_TICKERS_ADAPTER_VERSION),
  );
  provenanceIds.push(secProvenanceId);

  const secIndex = indexSecTickers(sec.entries);
  for (const ticker of secIndex.conflicts) {
    problems.push({
      kind: 'field_dropped',
      detail: `${ticker} appears under more than one CIK; no issuer join made`,
    });
    await openException(tx, {
      kind: 'source_conflict',
      entityKind: 'issuer',
      field: 'cik',
      candidates: [{ sourceId: 'sec.tickers', provenanceId: secProvenanceId, value: ticker }],
    });
  }

  const secValidFrom = publishedAt(secRaw);
  const at: AsOf = { validAt: secValidFrom, knownAt };

  // ── 2. the target set ─────────────────────────────────────────────────────────────────────
  const requested = options.tickers;
  const targets =
    requested === undefined
      ? await selectUnresolvedTickers(
          tx,
          [...secIndex.byTicker.keys()].sort(),
          at,
          options.maxTickers ?? DEFAULT_MAX_TICKERS,
        )
      : [...new Set(requested.map((t) => t.trim().toUpperCase()).filter((t) => t !== ''))].sort();

  if (targets.length === 0) return result('ok', []);

  const master = new MasterRepositories(tx);
  const ids = new IdentifierRepository(tx);

  // ── 3. issuers, from the SEC file, for the target tickers only ────────────────────────────
  const secWrite: WriteOptions = {
    validFrom: secValidFrom,
    provenanceId: secProvenanceId,
    knownAt,
  };
  const issuerIdByCik = new Map<string, number>();
  for (const ticker of targets) {
    const entry = secIndex.byTicker.get(ticker);
    if (entry === undefined) continue;
    if (issuerIdByCik.has(entry.cik)) continue;
    const existing = (await master.issuers.byCik(entry.cik, at))[0];
    const base: IssuerInput =
      existing === undefined ? { name: entry.title } : toIssuerInput(existing);
    // SEC `title` wins for the issuer name (PROVIDERS §6.1, §7.1).
    const input: IssuerInput = { ...base, name: entry.title, cik: entry.cik };
    let issuerId: number;
    if (existing === undefined) {
      issuerId = await master.issuers.insert(input, secWrite);
      tallyWrite(tally, issuerId, true);
      counts.issuers += 1;
    } else {
      issuerId = existing.issuerId;
      const versionId = await master.issuers.upsert(issuerId, input, secWrite);
      tallyWrite(tally, versionId, false);
      if (versionId !== null) counts.issuers += 1;
    }
    issuerIdByCik.set(entry.cik, issuerId);

    const cikWrite = await ids.upsertIfValid(
      {
        entityKind: 'issuer',
        entityId: issuerId,
        scheme: 'CIK',
        value: entry.cik,
        isPrimary: true,
      },
      secWrite,
    );
    if (cikWrite.ok) {
      tallyWrite(tally, cikWrite.versionId, existing === undefined);
      if (cikWrite.versionId !== null) counts.identifiers += 1;
    } else {
      problems.push({ kind: 'field_dropped', detail: `CIK ${entry.cik}: ${cikWrite.detail}` });
    }
  }

  // ── 4. OpenFIGI, one request per batch of tickers ─────────────────────────────────────────
  const jobsPerRequest = options.jobsPerRequest ?? DEFAULT_JOBS_PER_REQUEST;
  const tickersPerRequest = Math.max(1, Math.floor(jobsPerRequest / JOBS_PER_TICKER));
  const micByExchCode = await loadExchangeMics(tx);

  for (const batch of chunk(targets, tickersPerRequest)) {
    const jobs = openFigiJobsFor(batch);
    const body = openFigiBody(jobs);
    const raw = await fetchRaw(ctx, {
      providerId: 'openfigi.mapping',
      method: 'POST',
      url: OPENFIGI_MAPPING_URL,
      body,
    });
    fetched += 1;
    counts.requests += 1;

    if (raw.status === 304) {
      // Nothing new for this batch (PROVIDERS §1.3); the other batches still run.
      tally.skipped += 1;
      continue;
    }

    const parsed = parseOpenFigiMapping(raw.body, jobs);
    problems.push(...parsed.problems);
    if (parsed.elements.length === 0) {
      errors.push({
        code: 'SCHEMA_DRIFT',
        message: 'openfigi /v3/mapping payload dropped; see problems',
        url: OPENFIGI_MAPPING_URL,
        requestKey: raw.requestKey,
      });
      continue;
    }

    const provenanceId = await writeProvenance(
      tx,
      ctx,
      raw,
      adapterVersion(ctx.providers, 'openfigi.mapping', OPENFIGI_ADAPTER_VERSION),
    );
    provenanceIds.push(provenanceId);
    // One valid instant for the whole run (`secValidFrom`), not one per payload: the SEC capture
    // and the OpenFIGI capture are seconds apart, and a per-payload `valid_from` would make the
    // issuer invisible to an as-of read that can see the instrument it owns. The payloads' own
    // instants are not lost — they are on `provenance.captured_at` / `provenance.source_ts`.
    const write: WriteOptions = { validFrom: secValidFrom, provenanceId, knownAt };
    const readAt: AsOf = at;

    // Element i answers job i. Records for one ticker come from both of its jobs, deduped by FIGI.
    const byTicker = new Map<string, Map<string, OpenFigiRecord>>();
    for (const [index, job] of jobs.entries()) {
      const element = parsed.elements[index];
      if (element === undefined) continue;
      if (element.kind === 'error') {
        counts.unresolved += 1;
        problems.push({
          kind: 'unknown_symbol',
          detail: `${job.idType} ${job.idValue}: ${element.text}`,
          path: `/${String(index)}`,
        });
        await openException(tx, {
          kind: 'unresolved_identifier',
          entityKind: 'instrument',
          field: job.idType,
          candidates: [{ sourceId: 'openfigi.mapping', provenanceId, value: job.idValue }],
        });
        continue;
      }
      if (element.kind === 'warning') {
        problems.push({
          kind: 'field_dropped',
          detail: `${job.idType} ${job.idValue}: ${element.text}`,
          path: `/${String(index)}`,
        });
        continue;
      }
      const bucket = byTicker.get(job.idValue) ?? new Map<string, OpenFigiRecord>();
      for (const record of element.records) bucket.set(record.figi, record);
      byTicker.set(job.idValue, bucket);
    }

    for (const [ticker, records] of [...byTicker.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      counts.records += records.size;
      const issuerId = issuerIdOf(ticker, secIndex, issuerIdByCik);
      await writeComposites(
        { tx, master, ids, write, readAt, micByExchCode, tally, counts, problems },
        [...records.values()],
        issuerId,
      );
    }
  }

  return result(errors.length === 0 ? 'ok' : 'failed', targets);
}

function issuerIdOf(
  ticker: string,
  secIndex: SecTickerIndex,
  issuerIdByCik: Map<string, number>,
): number | null {
  const entry = secIndex.byTicker.get(ticker);
  if (entry === undefined) return null;
  return issuerIdByCik.get(entry.cik) ?? null;
}

/** `exchanges.bbg_exch_code` → `mic`, so a listing carries the MIC when the venue is known. */
async function loadExchangeMics(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx.execute<{ bbg_exch_code: string | null; mic: string }>(
    sql`SELECT bbg_exch_code, mic FROM exchanges WHERE bbg_exch_code IS NOT NULL`,
  );
  const out = new Map<string, string>();
  for (const row of rows.rows) {
    if (row.bbg_exch_code === null) continue;
    out.set(row.bbg_exch_code.trim().toUpperCase(), row.mic.trim());
  }
  return out;
}

interface WriteScope {
  tx: Tx;
  master: MasterRepositories;
  ids: IdentifierRepository;
  write: WriteOptions;
  readAt: AsOf;
  micByExchCode: Map<string, string>;
  tally: Tally;
  counts: SymbologyRefreshCounts;
  problems: NormaliseProblem[];
}

/**
 * One instrument per composite FIGI, its venue listings, and the identifiers that point at them.
 * `issuerId` is the SEC issuer of the target ticker, or `null` when the SEC file does not know it
 * — in which case no `issues` row can be written (`issues.issuer_id` is the parent key) and the
 * composite is deferred.
 */
async function writeComposites(
  scope: WriteScope,
  records: readonly OpenFigiRecord[],
  issuerId: number | null,
): Promise<void> {
  const groups = new Map<string, OpenFigiRecord[]>();
  for (const record of records) {
    const group = groups.get(record.compositeFIGI);
    if (group === undefined) groups.set(record.compositeFIGI, [record]);
    else group.push(record);
  }

  for (const [compositeFigi, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const composite = group.find((record) => record.figi === compositeFigi);
    if (composite === undefined) {
      // The payload answered for venue lines whose composite it did not return: the composite's
      // own ticker and exchange code are unknown, so there is nothing to key an instrument on.
      scope.counts.deferredNoComposite += 1;
      continue;
    }
    if (composite.exchCode !== COMPOSITE_EXCH_CODE) {
      scope.counts.deferredNonUs += 1;
      continue;
    }
    if (issuerId === null) {
      scope.counts.deferredNoComposite += 1;
      scope.problems.push({
        kind: 'unknown_symbol',
        detail: `${composite.ticker}: no SEC issuer for the ${compositeFigi} composite`,
      });
      continue;
    }
    const assetClass = assetClassForSecurityType(composite.securityType);
    if (assetClass === null) {
      scope.problems.push({
        kind: 'field_dropped',
        detail: `securityType ${JSON.stringify(composite.securityType)} has no asset_class mapping`,
      });
      continue;
    }
    const marketSector = marketSectorOf(composite.marketSector);
    if (marketSector === null) {
      scope.problems.push({
        kind: 'schema_drift',
        detail: `marketSector ${JSON.stringify(composite.marketSector)} is not a market_sector`,
      });
      continue;
    }

    const issueId = await writeIssue(scope, composite, issuerId, assetClass);
    const instrumentId = await writeInstrument(scope, composite, issueId, assetClass, marketSector);

    for (const record of group) {
      if (record.figi === compositeFigi) continue; // §6.1: the composite record is not a listing
      await writeListing(scope, record, instrumentId);
    }
  }
}

async function writeIssue(
  scope: WriteScope,
  composite: OpenFigiRecord,
  issuerId: number,
  assetClass: AssetClass,
): Promise<number> {
  const shareClassFigi = composite.shareClassFIGI;
  const existingId =
    shareClassFigi === undefined
      ? null
      : ((
          await scope.ids.entityOf(
            { scheme: 'SHARE_CLASS_FIGI', value: shareClassFigi, qualifier: '' },
            scope.readAt,
          )
        )?.entityId ?? null);
  const existing =
    existingId === null ? null : await scope.master.issues.get(existingId, scope.readAt);

  const base: IssueInput =
    existing === null
      ? {
          issuerId,
          assetClass,
          securityType: composite.securityType,
          name: composite.name,
          currency: US_CURRENCY,
        }
      : toIssueInput(existing);
  const input: IssueInput = {
    ...base,
    issuerId,
    assetClass,
    securityType: composite.securityType,
    name: composite.name,
    currency: existing === null ? US_CURRENCY : existing.currency,
  };
  if (composite.securityType2 !== undefined) input.securityType2 = composite.securityType2;
  if (shareClassFigi !== undefined) input.shareClassFigi = shareClassFigi;

  let issueId: number;
  if (existing === null) {
    issueId = await scope.master.issues.insert(input, scope.write);
    tallyWrite(scope.tally, issueId, true);
    scope.counts.issues += 1;
  } else {
    issueId = existing.issueId;
    const versionId = await scope.master.issues.upsert(issueId, input, scope.write);
    tallyWrite(scope.tally, versionId, false);
    if (versionId !== null) scope.counts.issues += 1;
  }

  if (shareClassFigi !== undefined) {
    await writeIdentifier(scope, {
      entityKind: 'issue',
      entityId: issueId,
      scheme: 'SHARE_CLASS_FIGI',
      value: shareClassFigi,
      created: existing === null,
    });
  }
  return issueId;
}

async function writeInstrument(
  scope: WriteScope,
  composite: OpenFigiRecord,
  issueId: number,
  assetClass: AssetClass,
  marketSector: MarketSector,
): Promise<number> {
  const existing = (
    await scope.master.instruments.byCompositeFigi(composite.compositeFIGI, scope.readAt)
  )[0];
  const base: InstrumentInput =
    existing === undefined
      ? {
          issueId,
          assetClass,
          marketSector,
          ticker: composite.ticker,
          exchCode: composite.exchCode,
          name: composite.name,
          currency: US_CURRENCY,
        }
      : toInstrumentInput(existing);
  // `name`, `status`, `search_weight` and `primary_listing_id` belong to other writers: whatever
  // the master already holds is written back unchanged (see the module comment).
  const input: InstrumentInput = {
    ...base,
    issueId,
    assetClass,
    marketSector,
    compositeFigi: composite.compositeFIGI,
    ticker: composite.ticker,
    exchCode: composite.exchCode,
  };

  let instrumentId: number;
  if (existing === undefined) {
    instrumentId = await scope.master.instruments.insert(input, scope.write);
    tallyWrite(scope.tally, instrumentId, true);
    scope.counts.instruments += 1;
  } else {
    instrumentId = existing.instrumentId;
    const versionId = await scope.master.instruments.upsert(instrumentId, input, scope.write);
    tallyWrite(scope.tally, versionId, false);
    if (versionId !== null) scope.counts.instruments += 1;
  }

  await writeIdentifier(scope, {
    entityKind: 'instrument',
    entityId: instrumentId,
    scheme: 'COMPOSITE_FIGI',
    value: composite.compositeFIGI,
    isPrimary: true,
    created: existing === undefined,
  });
  await writeIdentifier(scope, {
    entityKind: 'instrument',
    entityId: instrumentId,
    scheme: 'TICKER_EXCH',
    value: composite.ticker,
    qualifier: composite.exchCode,
    isPrimary: true,
    created: existing === undefined,
  });
  return instrumentId;
}

async function writeListing(
  scope: WriteScope,
  record: OpenFigiRecord,
  instrumentId: number,
): Promise<void> {
  const existing = (await scope.master.listings.byFigi(record.figi, scope.readAt))[0];
  const base: ListingInput =
    existing === undefined
      ? { instrumentId, exchCode: record.exchCode, localTicker: record.ticker }
      : toListingInput(existing);
  const input: ListingInput = {
    ...base,
    instrumentId,
    figi: record.figi,
    exchCode: record.exchCode,
    localTicker: record.ticker,
  };
  const mic = scope.micByExchCode.get(record.exchCode);
  if (mic !== undefined) input.mic = mic;

  let listingId: number;
  if (existing === undefined) {
    listingId = await scope.master.listings.insert(input, scope.write);
    tallyWrite(scope.tally, listingId, true);
    scope.counts.listings += 1;
  } else {
    listingId = existing.listingId;
    const versionId = await scope.master.listings.upsert(listingId, input, scope.write);
    tallyWrite(scope.tally, versionId, false);
    if (versionId !== null) scope.counts.listings += 1;
  }

  await writeIdentifier(scope, {
    entityKind: 'listing',
    entityId: listingId,
    scheme: 'FIGI',
    value: record.figi,
    created: existing === undefined,
  });
  await writeIdentifier(scope, {
    entityKind: 'listing',
    entityId: listingId,
    scheme: 'TICKER_EXCH',
    value: record.ticker,
    qualifier: record.exchCode,
    created: existing === undefined,
  });
}

async function writeIdentifier(
  scope: WriteScope,
  row: {
    entityKind: 'issuer' | 'issue' | 'instrument' | 'listing';
    entityId: number;
    scheme: 'FIGI' | 'COMPOSITE_FIGI' | 'SHARE_CLASS_FIGI' | 'TICKER_EXCH' | 'CIK';
    value: string;
    qualifier?: string;
    isPrimary?: boolean;
    created: boolean;
  },
): Promise<void> {
  const input = {
    entityKind: row.entityKind,
    entityId: row.entityId,
    scheme: row.scheme,
    value: row.value,
    ...(row.qualifier === undefined ? {} : { qualifier: row.qualifier }),
    ...(row.isPrimary === undefined ? {} : { isPrimary: row.isPrimary }),
  };
  const outcome = await scope.ids.upsertIfValid(input, scope.write);
  if (!outcome.ok) {
    scope.problems.push({
      kind: 'field_dropped',
      detail: `${row.scheme} ${row.value}: ${outcome.detail}`,
    });
    return;
  }
  tallyWrite(scope.tally, outcome.versionId, row.created);
  if (outcome.versionId !== null) scope.counts.identifiers += 1;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job table row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `IngestJob` as PROVIDERS §13 defines it. `provider` is the id the breaker and the rate budget
 * key on — OpenFIGI, the slower and more tightly rate-limited of the two sources; `sec.tickers` is
 * the other source this job reads and is listed in `providers`.
 *
 * WP-05 owns `ingest/scheduler.ts` and its `IngestJob` type; this object satisfies it
 * structurally, so registering it there is a one-line change.
 */
export const symbologyRefreshJob = {
  id: SYMBOLOGY_REFRESH_JOB_ID,
  schedule: SYMBOLOGY_REFRESH_SCHEDULE,
  provider: 'openfigi.mapping' as ProviderId,
  providers: ['openfigi.mapping', 'sec.tickers'] as readonly ProviderId[],
  priority: 3 as const,
  timeoutMs: SYMBOLOGY_REFRESH_TIMEOUT_MS,
  run: (ctx: SymbologyRefreshContext): Promise<SymbologyRefreshResult> => runSymbologyRefresh(ctx),
};
