/**
 * `universeSymbolBook` — the 35,618-entry Cboe symbol book, daily 06:30 ET.
 * PROVIDERS §13 (job table), §5.3 (`cboe.symbolBook`), ARCHITECTURE §7.1,
 * WORKPLAN §WP-04 L714-722.
 *
 * ## One writer
 *
 * This job **refreshes** master rows. It never creates them. The ≈36 k `instruments` +
 * `md_lines(cboe.quotes, …)` + `identifiers PROVIDER_SYMBOL` rows are written once by WP-15's
 * `seed/universe.ts` (DATA_MODEL §3.1); if this job created them too, the second writer would
 * collide with `md_lines_symbol_excl` and `identifiers_bt_excl` (SQLSTATE 23P01) on the first
 * overlapping symbol. So a `create` decision is *reported* — in `counts.create` and on the
 * candidate entries — and never applied. What it does apply, through `upsertVersion`:
 *
 *  * **name changes** — the Cboe `company_name` is the display name of the universe;
 *  * **status transitions to `'delisted'`** for a symbol that carried a `cboe.quotes` line and has
 *    left the book, and back to `'active'` for one that reappears;
 *  * **`search_weight`**, which the merge only ever raises (`refdata/universe.ts`): index
 *    membership and the seed know things the symbol book does not, and a daily downgrade of every
 *    index member to 0.5 would quietly ruin autocomplete.
 *
 * Everything else on the row — `issue_id`, `asset_class`, `market_sector`, `composite_figi`,
 * `primary_listing_id`, `price_decimals` — is read from the master and written back unchanged, so
 * `symbologyRefresh` and this job never fight over a column and the daily run of an unchanged
 * book writes zero versions (QA-02).
 *
 * ## The decision is pure
 *
 * `refdata/universe.ts#mergeUniverse` takes today's book, the SEC ticker file and the master rows
 * and returns one decision per `(ticker, exchCode)`. The seed and this job take the *same*
 * decisions from the same inputs; the only difference is which actions each is allowed to apply.
 * The merged entries are also this job's second product: the search candidates WP-08's
 * `/universe/snapshot` and WP-03's ranking bench are built from (PROVIDERS §5.3).
 *
 * ## Guards (PROVIDERS §5.3)
 *
 *  * fewer than 30,000 entries → `dq_events kind 'poll_anomaly'`, `details {expected, actual}`,
 *    **nothing written**, the previous universe stays live: a truncated file silently breaking
 *    autocomplete for a day is the failure mode this exists for;
 *  * more than a 2 % day-over-day drop → `data_exceptions kind 'source_conflict'` **and**
 *    delistings are suppressed for the run. A shrinking book is a bad file far more often than it
 *    is five hundred simultaneous delistings; refreshes still apply.
 *  * a duplicate `name` keeps the first entry and raises a `field_dropped` problem (in
 *    `mergeUniverse`).
 *
 * `config_versions('universe')` is bumped when anything was written — the freshness marker §5.3
 * and §6.1 point the SECF footer and the DES footer at.
 */

import { sql } from 'drizzle-orm';

import { SystemClock } from '@terminal/core';
import type { Clock } from '@terminal/core';

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
import { MasterRepositories, toInstrumentInput } from '../../refdata/master.js';
import type { InstrumentInput, WriteOptions } from '../../refdata/master.js';
import {
  EXPECTED_SYMBOL_BOOK_ENTRIES,
  MIN_SYMBOL_BOOK_ENTRIES,
  loadMasterUniverse,
  mergeUniverse,
  symbolBookShrink,
} from '../../refdata/universe.js';
import type {
  CboeSymbolBookEntry,
  SecTickerEntry,
  UniverseEntry,
  UniverseMergeResult,
  UniverseProblem,
} from '../../refdata/universe.js';

import type { JobError } from './symbologyRefresh.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants — PROVIDERS §13, §5.3
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `IngestJob.id` = the module basename = `ingest_runs.job_id`. */
export const UNIVERSE_SYMBOL_BOOK_JOB_ID = 'universeSymbolBook';

/** PROVIDERS §13: daily 06:30 ET. */
export const UNIVERSE_SYMBOL_BOOK_SCHEDULE = '30 6 * * *';

/** PROVIDERS §13. */
export const UNIVERSE_SYMBOL_BOOK_TIMEOUT_MS = 60_000;

export const CBOE_SYMBOL_BOOK_URL =
  'https://cdn.cboe.com/api/global/delayed_quotes/symbol_book/symbol-book.json';

/** PROVIDERS §5.3: `cacheTtlMs 6 h`. */
export const SYMBOL_BOOK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** `provenance.adapter_version` when the registry holds no adapter yet (PROVIDERS §1.4). */
export const CBOE_SYMBOL_BOOK_ADAPTER_VERSION = 'cboe/1.0.0';

/** The `config_versions` row §5.3 names as the universe's freshness marker. */
export const UNIVERSE_CONFIG_NAME = 'universe';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SymbolBookParse {
  entries: CboeSymbolBookEntry[];
  /**
   * The payload's own `timestamp`, verbatim (`'2026-09-15 18:00:09'`). It carries no zone, so it
   * is reported rather than parsed; the authoritative instant is `provenance.source_ts`.
   */
  timestamp: string | null;
  problems: NormaliseProblem[];
}

function textOf(body: Buffer | string): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}

/**
 * `{timestamp, data: [{name, company_name}]}` → entries (PROVIDERS §5.3). Never throws: a
 * malformed payload is zero entries plus a `parse_error`, which the caller turns into a
 * `poll_anomaly` and a run that writes nothing.
 */
export function parseSymbolBook(body: Buffer | string): SymbolBookParse {
  let doc: unknown;
  try {
    doc = JSON.parse(textOf(body));
  } catch (err) {
    return {
      entries: [],
      timestamp: null,
      problems: [{ kind: 'parse_error', detail: err instanceof Error ? err.message : String(err) }],
    };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      entries: [],
      timestamp: null,
      problems: [{ kind: 'schema_drift', detail: 'symbol-book.json is not a JSON object' }],
    };
  }
  const root = doc as { timestamp?: unknown; data?: unknown };
  const timestamp = typeof root.timestamp === 'string' ? root.timestamp : null;
  if (!Array.isArray(root.data)) {
    return {
      entries: [],
      timestamp,
      problems: [{ kind: 'schema_drift', detail: 'symbol-book.json has no data[] array' }],
    };
  }

  const problems: NormaliseProblem[] = [];
  const entries: CboeSymbolBookEntry[] = [];
  let dropped = 0;
  root.data.forEach((value) => {
    if (typeof value !== 'object' || value === null) {
      dropped += 1;
      return;
    }
    const row = value as { name?: unknown; company_name?: unknown };
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const companyName = typeof row.company_name === 'string' ? row.company_name.trim() : '';
    if (name === '') {
      dropped += 1;
      return;
    }
    entries.push({ name, companyName });
  });
  if (dropped > 0) {
    problems.push({
      kind: 'field_dropped',
      detail: `${String(dropped)} symbol-book entries carried no name`,
    });
  }
  return { entries, timestamp, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Job context and result
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** All-optional, so the scheduler's `JobContext` (ARCHITECTURE L994) satisfies it structurally. */
export interface UniverseSymbolBookContext {
  tx?: Tx;
  db?: Db;
  clock?: Clock;
  providers?: ProviderRegistry;
  http?: HttpClient;
  store?: ReplayStore;
  traceId?: string;
  runId?: number;
}

export interface UniverseSymbolBookOptions {
  /**
   * The SEC ticker file, when the caller has it. The merge uses it only to *raise* a weight to
   * `secKnown`, never to lower one, so omitting it can only leave a weight where it was.
   */
  secTickers?: readonly SecTickerEntry[];
  /** Yesterday's entry count, for the 2 % shrink guard. Omitted → the guard cannot fire. */
  previousEntryCount?: number;
  /** Skip the `config_versions('universe')` bump (a dry run, or a caller that owns the bump). */
  touchConfigVersion?: boolean;
}

export interface UniverseSymbolBookResult {
  jobId: typeof UNIVERSE_SYMBOL_BOOK_JOB_ID;
  status: 'ok' | 'skipped' | 'failed';
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: JobError[];
  provenanceIds: number[];
  problems: NormaliseProblem[];
  /** The payload's own `timestamp` string, verbatim. */
  bookTimestamp: string | null;
  /** How many instruments were refreshed / delisted, and what the merge decided overall. */
  refreshed: number;
  delisted: number;
  /** True when the shrink guard fired and delistings were held back. */
  delistingsSuppressed: boolean;
  counts: UniverseMergeResult['counts'];
  /** The search candidates this run contributes: one entry per `(ticker, exchCode)`. */
  candidates: UniverseEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────────────────────

function fetchRaw(
  ctx: UniverseSymbolBookContext,
  spec: { providerId: ProviderId; method: HttpMethod; url: string; cacheTtlMs?: number },
): Promise<RawRecord> {
  const http = ctx.http;
  if (http !== undefined) {
    const req: HttpRequest = {
      providerId: spec.providerId,
      method: spec.method,
      url: spec.url,
      budgetShare: 'scheduler',
    };
    if (spec.cacheTtlMs !== undefined) req.cacheTtlMs = spec.cacheTtlMs;
    if (ctx.traceId !== undefined) req.traceId = ctx.traceId;
    if (ctx.runId !== undefined) req.runId = ctx.runId;
    return http.get(req);
  }
  const store = ctx.store ?? openReplayStore();
  return Promise.resolve(
    store.replay({ providerId: spec.providerId, method: spec.method, url: spec.url }),
  );
}

function adapterVersion(providers: ProviderRegistry | undefined, id: ProviderId): string {
  return providers?.get(id)?.adapterVersion ?? CBOE_SYMBOL_BOOK_ADAPTER_VERSION;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run the job.
 *
 * @param ctx transaction / clock / transport; `ctx.tx` is used when given, otherwise the job opens
 *            `withTx(null, …)`, which nests as a SAVEPOINT inside an ambient transaction.
 * @param options the SEC join, the shrink guard's baseline and the `config_versions` bump.
 */
export async function runUniverseSymbolBook(
  ctx: UniverseSymbolBookContext = {},
  options: UniverseSymbolBookOptions = {},
): Promise<UniverseSymbolBookResult> {
  if (ctx.tx !== undefined) return execute(ctx.tx, ctx, options);
  return withTx(null, (tx) => execute(tx, ctx, options));
}

async function execute(
  tx: Tx,
  ctx: UniverseSymbolBookContext,
  options: UniverseSymbolBookOptions,
): Promise<UniverseSymbolBookResult> {
  const clock = ctx.clock ?? new SystemClock();
  const knownAt = new Date(clock.now());
  const problems: NormaliseProblem[] = [];
  const errors: JobError[] = [];
  const provenanceIds: number[] = [];

  const raw = await fetchRaw(ctx, {
    providerId: 'cboe.symbolBook',
    method: 'GET',
    url: CBOE_SYMBOL_BOOK_URL,
    cacheTtlMs: SYMBOL_BOOK_CACHE_TTL_MS,
  });
  const parse = parseSymbolBook(raw.body);
  problems.push(...parse.problems);

  // PROVIDERS §1.3: a 304 publishes nothing new — no provenance row, no versions, counted in
  // `ingest_runs.skipped`. With `cacheTtlMs 6 h` on this source that is the ordinary answer to a
  // second run inside the same morning.
  if (raw.status === 304) {
    return {
      jobId: UNIVERSE_SYMBOL_BOOK_JOB_ID,
      status: 'skipped',
      fetched: 1,
      inserted: 0,
      updated: 0,
      skipped: 1,
      errors,
      provenanceIds,
      problems,
      bookTimestamp: parse.timestamp,
      refreshed: 0,
      delisted: 0,
      delistingsSuppressed: false,
      counts: {
        master: 0,
        symbolBook: parse.entries.length,
        secTickers: options.secTickers?.length ?? 0,
        create: 0,
        refresh: 0,
        delist: 0,
        unchanged: 0,
      },
      candidates: [],
    };
  }

  const empty: UniverseMergeResult['counts'] = {
    master: 0,
    symbolBook: parse.entries.length,
    secTickers: options.secTickers?.length ?? 0,
    create: 0,
    refresh: 0,
    delist: 0,
    unchanged: 0,
  };

  // ── the 30,000-entry floor: nothing is written, the previous universe stays live ───────────
  if (parse.entries.length < MIN_SYMBOL_BOOK_ENTRIES) {
    await tx.insert(dqEvents).values({
      kind: 'poll_anomaly',
      severity: 'error',
      sourceId: 'cboe.symbolBook',
      subject: 'symbol-book.json',
      details: { expected: EXPECTED_SYMBOL_BOOK_ENTRIES, actual: parse.entries.length },
    });
    errors.push({
      code: 'POLL_ANOMALY',
      message:
        `symbol book carried ${String(parse.entries.length)} entries, fewer than the ` +
        `${String(MIN_SYMBOL_BOOK_ENTRIES)} floor; the previous universe stands`,
      url: CBOE_SYMBOL_BOOK_URL,
      requestKey: raw.requestKey,
    });
    return {
      jobId: UNIVERSE_SYMBOL_BOOK_JOB_ID,
      status: 'skipped',
      fetched: 1,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors,
      provenanceIds,
      problems,
      bookTimestamp: parse.timestamp,
      refreshed: 0,
      delisted: 0,
      delistingsSuppressed: false,
      counts: empty,
      candidates: [],
    };
  }

  const provenanceId = await insertProvenance(tx, raw, buildMeta(ctx));
  provenanceIds.push(provenanceId);

  const validFrom = raw.sourceTs ?? new Date(raw.capturedAt);
  const at: AsOf = { validAt: validFrom, knownAt };
  const write: WriteOptions = { validFrom, provenanceId, knownAt };

  const master = await loadMasterUniverse(tx, at);
  const merged = mergeUniverse({
    master,
    symbolBook: parse.entries,
    secTickers: options.secTickers ?? [],
  });
  for (const problem of merged.problems) problems.push(toNormaliseProblem(problem));

  // ── the 2 % shrink guard: refresh, but do not delist on a suspicious file ──────────────────
  const shrink = symbolBookShrink(parse.entries.length, options.previousEntryCount ?? null);
  if (shrink !== null) {
    problems.push(toNormaliseProblem(shrink));
    await tx.insert(dataExceptions).values({
      kind: 'source_conflict',
      field: 'symbol_book_entries',
      candidates: [
        {
          sourceId: 'cboe.symbolBook',
          provenanceId,
          value: `${String(options.previousEntryCount ?? 0)} → ${String(parse.entries.length)}`,
        },
      ],
    });
  }
  const delistingsSuppressed = shrink !== null;

  // ── apply: refresh and delist only, never create ──────────────────────────────────────────
  const repositories = new MasterRepositories(tx);
  // Nothing is ever created here (the one-writer rule), so `inserted` is structurally zero.
  const inserted = 0;
  let updated = 0;
  let skipped = 0;
  let refreshed = 0;
  let delisted = 0;

  for (const entry of merged.entries) {
    if (entry.action === 'unchanged' || entry.action === 'create') continue;
    if (entry.action === 'delist' && delistingsSuppressed) {
      skipped += 1;
      continue;
    }
    const instrumentId = entry.instrumentId;
    if (instrumentId === null) {
      // `refresh`/`delist` are only ever decided for a row that exists; a null id here would be a
      // bug in the merge rather than a data problem, and silently skipping it would hide it.
      problems.push({
        kind: 'schema_drift',
        detail: `${entry.key}: action ${entry.action} with no instrument_id`,
      });
      continue;
    }
    const existing = await repositories.instruments.get(instrumentId, at);
    if (existing === null) {
      skipped += 1;
      continue;
    }
    const input: InstrumentInput = {
      ...toInstrumentInput(existing),
      name: entry.name,
      status: entry.status,
      searchWeight: entry.searchWeight,
    };
    const versionId = await repositories.instruments.upsert(instrumentId, input, write);
    if (versionId === null) {
      skipped += 1;
      continue;
    }
    updated += 1;
    if (entry.action === 'delist') delisted += 1;
    else refreshed += 1;
  }

  if ((options.touchConfigVersion ?? true) && updated > 0) {
    await tx.execute(sql`
      UPDATE config_versions
         SET version = version + 1, updated_at = ${knownAt.toISOString()}::timestamptz
       WHERE name = ${UNIVERSE_CONFIG_NAME}`);
  }

  return {
    jobId: UNIVERSE_SYMBOL_BOOK_JOB_ID,
    status: errors.length === 0 ? 'ok' : 'failed',
    fetched: 1,
    inserted,
    updated,
    skipped,
    errors,
    provenanceIds,
    problems,
    bookTimestamp: parse.timestamp,
    refreshed,
    delisted,
    delistingsSuppressed,
    counts: merged.counts,
    candidates: merged.entries,
  };
}

function buildMeta(ctx: UniverseSymbolBookContext): {
  adapterVersion: string;
  traceId?: string;
  runId?: number;
} {
  const meta: { adapterVersion: string; traceId?: string; runId?: number } = {
    adapterVersion: adapterVersion(ctx.providers, 'cboe.symbolBook'),
  };
  if (ctx.traceId !== undefined) meta.traceId = ctx.traceId;
  if (ctx.runId !== undefined) meta.runId = ctx.runId;
  return meta;
}

/** `UniverseProblem` (a merge decision) → the adapter problem vocabulary of PROVIDERS §1.2. */
function toNormaliseProblem(problem: UniverseProblem): NormaliseProblem {
  return {
    kind:
      problem.kind === 'symbol_book_short' || problem.kind === 'symbol_book_shrunk'
        ? 'out_of_range'
        : 'field_dropped',
    detail: problem.detail,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job table row (PROVIDERS §13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `IngestJob` as PROVIDERS §13 defines it. WP-05 owns `ingest/scheduler.ts` and its `IngestJob`
 * type; this object satisfies it structurally.
 */
export const universeSymbolBookJob = {
  id: UNIVERSE_SYMBOL_BOOK_JOB_ID,
  schedule: UNIVERSE_SYMBOL_BOOK_SCHEDULE,
  provider: 'cboe.symbolBook' as ProviderId,
  providers: ['cboe.symbolBook'] as readonly ProviderId[],
  priority: 3 as const,
  timeoutMs: UNIVERSE_SYMBOL_BOOK_TIMEOUT_MS,
  run: (ctx: UniverseSymbolBookContext): Promise<UniverseSymbolBookResult> =>
    runUniverseSymbolBook(ctx),
};
