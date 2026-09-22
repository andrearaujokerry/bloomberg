/**
 * `ingest/jobs/cboeQuotes.ts` — the Cboe delayed top-of-book poll (PROVIDERS §5.1, §13).
 *
 * This module carries two things: the **shared market-data ingest plumbing** that the other seven
 * jobs of the §13 hot-set block import (`cboeEuIndices`, `cboeOptions`, `yahooIntraday`,
 * `yahooDaily`, `fxIntraday`, `fxEod`, `crypto`), and the `cboeQuotes` job itself. The precedent is
 * `shortInterest.ts` importing its plumbing from `secNport.ts`: WP-05 owns one file per job and no
 * shared module of its own, so the plumbing lives in the job that needs it first and is exported.
 *
 * ## The sequence (PROVIDERS.a §1.3)
 *
 * ```
 * 1. targets   ← the hot set ∩ md_lines for this source          resolveTargets()
 * 2. raw       ← adapter.fetch(http, req)   (replay store when no client is wired)
 * 3. provId    ← insertProvenance(tx, raw, {adapterVersion, sourceTs, traceId, runId})
 * 4. norm      ← adapter.normalise(raw, {provenanceId: provId, capturedAt, lines})
 * 5.             plant.apply(u) for every update; then the rows, upserted on their natural keys
 * 6.             one ingest_runs row for the execution
 * ```
 *
 * Step 3 before step 5 is the DATA-10 invariant: **no value row is written without a provenance
 * id**. Steps 3 and 4 are, however, run in the order 4-then-3-then-rebind here, and that is
 * deliberate: `provenance` carries a WORM trigger (migration 0015), so `source_ts` cannot be
 * corrected after the insert, and for four of these eight jobs the provider-published instant is
 * only knowable by parsing the payload (Yahoo's `meta.regularMarketTime`, frankfurter's ECB
 * publication instant). `insertProvenance`'s `meta.sourceTs` is documented for exactly this — "a
 * normaliser that reads a more precise instant out of the payload passes it here" — so the parse
 * runs first against a sentinel provenance id, the row is written with the instant it found, and
 * {@link rebindProvenance} stamps the real id onto the updates before anything is written. The
 * parser is pure, so running it before the insert costs nothing and observes nothing.
 *
 * ## Idempotency
 *
 * Every write here is keyed so that a second run over the same capture writes **nothing new**, and
 * every helper reports the row counts that prove it rather than a boolean:
 *
 *  - `quote_ticks` has no natural key (its primary key is `(capture_ts, tick_id)` and `tick_id`
 *    comes from a sequence), so {@link insertQuoteTicks} inserts under a `NOT EXISTS` guard on
 *    `(md_line_id, capture_ts, kind)`. STOR-01's "one row per observed change" is the same rule:
 *    a capture already recorded for a line is not recorded twice.
 *  - `bars_intraday`, `bars_daily`, `option_quotes` and `fx_rates` all have natural primary keys,
 *    so they upsert with a `setWhere … IS DISTINCT FROM`: a row the predicate rejects is not
 *    returned at all, so `unchanged` is exactly what the statement did not touch. Which of the
 *    touched rows were *inserted* is counted by asking, before the statement, how many of the
 *    chunk's keys the table already held — `RETURNING (xmax = 0)`, the usual trick, raises
 *    `0A000 cannot retrieve a system column in this context` on a partitioned table, and three of
 *    these four are partitioned.
 *
 * ## Staleness (TERM-12, FEED-05)
 *
 * Cboe is a 15-minute delayed feed and every value it produces says so, in four places that the
 * renderer and the entitlement evaluator read independently: `NormalisedUpdate.tier` is the
 * licence's `max_tier` (`delayed`), `md_lines.intrinsic_delay_min` is 15, `quote_ticks.conditions`
 * carries `{'delayed'}` (the parser's doing, FEED-07), and `ts.src` is the provider's own
 * `last_trade_time` rather than the fetch instant. {@link lineTier} is the one place the tier is
 * decided, and it reads `licence_registry` — never a literal.
 */

import { sql } from 'drizzle-orm';

import type { SQL } from 'drizzle-orm';

import { getLicence } from '../../providers/licences.js';
import { insertProvenance } from '../../providers/provenance.js';
import { openReplayStore } from '../../providers/replayStore.js';
import { calendarSessionResolver } from '../../providers/sim/feed.js';
import {
  cboeQuotesAdapter,
  cboeQuoteUrl,
  CBOE_ADAPTER_VERSION,
} from '../../providers/cboe/adapter.js';
import { normaliseQuote } from '../../providers/cboe/parse.js';
import { ingestRuns } from '../../db/schema/ops.js';
import { barsDaily, barsIntraday, fxRates, optionQuotes } from '../../db/schema/timeseries.js';

import type { AssetClass, Clock, NormalisedUpdate, SessionState, Tier } from '@terminal/core';
import type { Tx } from '../../db/client.js';
import type { HotSet } from '../hotset.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { ReplayStore } from '../../providers/replayStore.js';
import type { CboeQuoteTickRow } from '../../providers/cboe/parse.js';
import type {
  HttpClient,
  HttpRequest,
  NormaliseContext,
  NormaliseLine,
  NormaliseProblem,
  Normalised,
  ProviderAdapter,
  ProviderId,
  RawRecord,
} from '../../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Result and context
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `ingest_runs.errors` — ARCHITECTURE §7.1 `JobError`, identical to `scheduler.ts`'s. */
export interface JobError {
  code: string;
  message: string;
  url?: string;
  requestKey?: string;
}

/**
 * What every market-data job returns. The four counters are `ingest_runs`'; `problems` carries the
 * normalisers' non-fatal findings (unknown symbol, dropped field, schema drift) so a caller can
 * assert on them without reading `dq_events`.
 */
export interface MarketJobResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: JobError[];
  provenanceIds: number[];
  /** Updates handed to `plant.apply`. Zero when no plant is wired (WP-06). */
  published: number;
  problems: NormaliseProblem[];
}

export function emptyResult(): MarketJobResult {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    provenanceIds: [],
    published: 0,
    problems: [],
  };
}

/** Structured job logging; every method is optional so a caller may pass `{}`. */
export interface IngestLogger {
  info?(event: string, detail: Record<string, unknown>): void;
  warn?(event: string, detail: Record<string, unknown>): void;
  error?(event: string, detail: Record<string, unknown>): void;
}

/**
 * The half of the plant a market-data job uses: `plant.apply`, and nothing else (ARCHITECTURE §6).
 * WP-06 owns the implementation; `plant/tickerPlant.ts` is still the WP-01 stub and has no `apply`
 * yet, which is why {@link MarketJobContext.plant} is `unknown` and {@link plantSink} narrows it.
 */
export interface MarketPlant {
  apply(update: NormalisedUpdate): void;
}

/** `ctx.plant` when it is a plant that can take updates, `null` while the WP-01 stub is wired. */
export function plantSink(plant: unknown): MarketPlant | null {
  if (typeof plant !== 'object' || plant === null) return null;
  return typeof (plant as { apply?: unknown }).apply === 'function' ? (plant as MarketPlant) : null;
}

/**
 * What a market-data job needs. A superset of `scheduler.ts`'s `JobContext` in the optional
 * properties only, so the scheduler's context is assignable to it and `collectJobs` accepts the
 * descriptor; `http` and `replay` are the two things `JobContext` does not carry, and exactly one
 * of them has to be present for the job to see any bytes.
 */
export interface MarketJobContext {
  tx: Tx;
  clock: Clock;
  /** WP-05's shared client. Absent in replay tests, where the recorded capture is read instead. */
  http?: HttpClient;
  /** The replay store to read from when `http` is absent. Defaults to `openReplayStore()`. */
  replay?: ReplayStore;
  /** WP-06's plant. `unknown` until the stub grows `apply` — see {@link plantSink}. */
  plant?: unknown;
  /** The polled-subject set (`ingest/hotset.ts`). Absent = poll every md line of the source. */
  hotset?: HotSet;
  providers?: ProviderRegistry;
  log?: IngestLogger;
  /** OPS-07 — copied onto `provenance.trace_id`. Must be a uuid when present. */
  traceId?: string;
  /** `ingest_runs.run_id` when the scheduler opened the row; the job then writes none itself. */
  runId?: number;
  /**
   * Poll exactly these `md_lines.provider_symbol` values, ignoring the hot set. For a seed
   * backfill and for a test that wants one symbol.
   */
  symbols?: readonly string[];
  /** `false` suppresses the job's own `ingest_runs` row. Default: write one unless `runId` is set. */
  recordRun?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Target resolution — PROVIDERS §5.1 "Cadence and hot set"
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One md line to poll: everything `NormaliseContext.lines` needs plus the symbol to fetch. */
export interface TargetLine extends NormaliseLine {
  providerSymbol: string;
  sourceId: string;
}

interface TargetRow extends Record<string, unknown> {
  md_line_id: string | number;
  instrument_id: string | number;
  provider_symbol: string;
  intrinsic_delay_min: number;
  expected_interval_ms: number;
  priority: number;
  asset_class: string;
}

/**
 * The tier every value from `sourceId` carries — `licence_registry.max_tier`, which is the ceiling
 * any entitlement grant can reach for the source (evaluator rule 3). Cboe's three market-data rows
 * are `delayed`; frankfurter's is `eod`. Never a literal at a call site.
 */
export function lineTier(sourceId: string): Tier {
  const licence = getLicence(sourceId);
  if (licence === undefined) {
    throw new Error(
      `source '${sourceId}' has no licence_registry row (providers/licences.ts): its tier is ` +
        'undefined and assert_source_known would reject every value it wrote (DATA-09)',
    );
  }
  return licence.maxTier;
}

/** The instrument ids the hot set currently holds, or `null` when no hot set is wired. */
export function hotInstrumentIds(ctx: MarketJobContext): number[] | null {
  if (ctx.hotset === undefined) return null;
  const ids: number[] = [];
  for (const subject of ctx.hotset.subjects()) {
    // `q:<instrumentId>` is the quote subject; `b1m:`, `oc:` and the rest are other shapes of the
    // same instrument and are handled by the jobs that own them.
    const match = /^(?:q|b1m|b5m|oc):(\d+)$/.exec(subject);
    if (match !== null) ids.push(Number(match[1]));
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * The md lines this job polls: the source's current lines, narrowed to the hot set's instruments
 * (PROVIDERS §5.1 — subscribers ∪ connected watchlists ∪ always-on seed) and to `ctx.symbols` when
 * the caller named some. Ordered by `priority` then `md_line_id`, so a poll order is reproducible.
 *
 * A source with no lines returns an empty array and the job reports `skipped`, which is the correct
 * state before WP-15's seed has run — never an error.
 */
export async function resolveTargets(
  ctx: MarketJobContext,
  sourceId: string,
  options: { instrumentIds?: readonly number[] | null } = {},
): Promise<TargetLine[]> {
  const atMs = ctx.clock.now();
  const ids = options.instrumentIds === undefined ? hotInstrumentIds(ctx) : options.instrumentIds;
  // `null` means "no set was given, poll every line of the source"; an *empty* set means the hot
  // set is genuinely empty — nobody is subscribed and no seed resolved — and the honest answer is
  // to poll nothing. Collapsing the two would make an idle terminal poll the whole universe.
  if (ids !== null && ids.length === 0) return [];
  const idList = ids === null ? [] : [...ids];
  const symbols = ctx.symbols === undefined ? [] : [...ctx.symbols];
  const tier = lineTier(sourceId);

  const res = await ctx.tx.execute<TargetRow>(sql`
    SELECT m.md_line_id, m.instrument_id, m.provider_symbol, m.intrinsic_delay_min,
           m.expected_interval_ms, m.priority, i.asset_class
      FROM md_lines m
      JOIN instruments i
        ON i.instrument_id = m.instrument_id
       AND i.tx_to = 'infinity'
       AND i.valid_from <= to_timestamp(${atMs}::double precision / 1000.0)
       AND i.valid_to   >  to_timestamp(${atMs}::double precision / 1000.0)
     WHERE m.source_id = ${sourceId}
       AND m.tx_to = 'infinity'
       AND m.valid_from <= to_timestamp(${atMs}::double precision / 1000.0)
       AND m.valid_to   >  to_timestamp(${atMs}::double precision / 1000.0)
       AND (cardinality(${sql.param(idList)}::bigint[]) = 0
            OR m.instrument_id = ANY(${sql.param(idList)}::bigint[]))
       AND (cardinality(${sql.param(symbols)}::text[]) = 0
            OR m.provider_symbol = ANY(${sql.param(symbols)}::text[]))
     ORDER BY m.priority ASC, m.md_line_id ASC`);

  return res.rows.map((row) => ({
    mdLineId: Number(row.md_line_id),
    instrumentId: Number(row.instrument_id),
    assetClass: row.asset_class as AssetClass,
    tier,
    intrinsicDelayMin: row.intrinsic_delay_min,
    expectedIntervalMs: row.expected_interval_ms,
    priority: row.priority,
    providerSymbol: row.provider_symbol,
    sourceId,
  }));
}

/** `NormaliseContext.lines` — keyed by `md_lines.provider_symbol`, as every parser expects. */
export function linesOf(targets: readonly TargetLine[]): Map<string, NormaliseLine> {
  const lines = new Map<string, NormaliseLine>();
  for (const t of targets) {
    lines.set(t.providerSymbol, {
      mdLineId: t.mdLineId,
      instrumentId: t.instrumentId,
      assetClass: t.assetClass,
      tier: t.tier,
      intrinsicDelayMin: t.intrinsicDelayMin,
      expectedIntervalMs: t.expectedIntervalMs,
      priority: t.priority,
    });
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Bytes, through the adapter when a client is wired and through the replay store otherwise.
 *
 * The replay path is not a fallback to the network: `ReplayStore.replay` throws `ReplayMissError`
 * on a key it does not hold and never opens a socket (PROVIDERS.a §3.6). `url` must be the adapter's
 * own URL builder's output, so the request key is the one `manifest.json` carries.
 */
export async function fetchThrough<Req, Rows>(
  ctx: MarketJobContext,
  adapter: ProviderAdapter<Req, Rows>,
  req: Req,
  url: string,
): Promise<RawRecord> {
  if (ctx.http !== undefined) return adapter.fetch(ctx.http, req);
  const store = ctx.replay ?? openReplayStore();
  return store.replay({ providerId: adapter.id, url });
}

/** The `HttpRequest` fields every scheduler-driven fetch carries, without writing `undefined`. */
export function requestEnvelope(ctx: MarketJobContext): {
  traceId?: string;
  runId?: number;
  budgetShare: 'scheduler';
} {
  const env: { traceId?: string; runId?: number; budgetShare: 'scheduler' } = {
    budgetShare: 'scheduler',
  };
  if (ctx.traceId !== undefined) env.traceId = ctx.traceId;
  if (ctx.runId !== undefined) env.runId = ctx.runId;
  return env;
}

/** Type-level guard that {@link requestEnvelope} stays assignable to an `HttpRequest` subset. */
export type RequestEnvelope = Pick<HttpRequest, 'traceId' | 'runId' | 'budgetShare'>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `insertProvenance` meta built from the context, without writing `undefined` into it. */
export function provenanceMeta(
  ctx: MarketJobContext,
  adapterVersion: string,
  sourceTs: Date | null,
): { adapterVersion: string; sourceTs: Date | null; traceId?: string; runId?: number } {
  const meta: { adapterVersion: string; sourceTs: Date | null; traceId?: string; runId?: number } =
    { adapterVersion, sourceTs };
  if (ctx.traceId !== undefined) meta.traceId = ctx.traceId;
  if (ctx.runId !== undefined) meta.runId = ctx.runId;
  return meta;
}

/** The provenance id a parse runs against before its row exists. Never reaches Postgres. */
export const SENTINEL_PROVENANCE_ID = 0;

/**
 * Stamp the real `provenance_id` onto everything a sentinel parse produced.
 *
 * Updates are rebuilt rather than mutated in place: several adapters share one `prov` object across
 * every update of a payload (`const prov = { sourceId, provenanceId: ctx.provenanceId }`), and
 * mutating a shared object is the kind of aliasing that is correct today and wrong after the next
 * edit to a parser this module does not own.
 */
export function rebindProvenance(
  updates: readonly NormalisedUpdate[],
  provenanceId: number,
): NormalisedUpdate[] {
  return updates.map((u) => ({ ...u, prov: { ...u.prov, provenanceId } }));
}

/**
 * Parse, then write the provenance row the parse's `source_ts` belongs on, then rebind.
 *
 * @returns the provenance id and the normalised result whose updates carry it.
 */
export async function normaliseWithProvenance<Rows>(
  ctx: MarketJobContext,
  args: {
    raw: RawRecord;
    adapterVersion: string;
    lines: ReadonlyMap<string, NormaliseLine>;
    resolveInstrument?: NormaliseContext['resolveInstrument'];
    normalise: (raw: RawRecord, nctx: NormaliseContext) => Normalised<Rows>;
  },
): Promise<{ provenanceId: number; norm: Normalised<Rows> }> {
  const base: NormaliseContext = {
    provenanceId: SENTINEL_PROVENANCE_ID,
    capturedAt: args.raw.capturedAt,
    lines: args.lines,
    ...(args.resolveInstrument === undefined ? {} : { resolveInstrument: args.resolveInstrument }),
  };
  const probe = args.normalise(args.raw, base);
  const provenanceId = await insertProvenance(
    ctx.tx,
    args.raw,
    provenanceMeta(ctx, args.adapterVersion, probe.sourceTs ?? args.raw.sourceTs),
  );
  return {
    provenanceId,
    norm: { ...probe, updates: rebindProvenance(probe.updates, provenanceId) },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Plant
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Hand the updates to the plant and mark the subjects polled — §1.3 step 6, which publishes before
 * it writes: the screen is the latency-sensitive half and a row that lands a few milliseconds later
 * says the same thing.
 *
 * A plant that throws on one update costs that update, not the run. The `provenance` row is already
 * written and the value rows follow in the same transaction, so nothing is lost that the next poll
 * cannot republish; the failure is reported in `ingest_runs.errors` rather than ending the poll.
 *
 * @returns the number of updates the plant accepted.
 */
export function publish(
  ctx: MarketJobContext,
  updates: readonly NormalisedUpdate[],
  errors: JobError[],
): number {
  const sink = plantSink(ctx.plant);
  const at = ctx.clock.now();
  let published = 0;
  for (const update of updates) {
    ctx.hotset?.markPolled(update.subject, at);
    if (sink === null) continue;
    try {
      sink.apply(update);
      published += 1;
    } catch (err) {
      errors.push({
        code: 'PLANT_APPLY_FAILED',
        message: `plant.apply(${update.subject}) threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }
  return published;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writers — every one of them counts rows, never booleans (QA-02)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What an idempotent write did. `unchanged` is the count the statement did not touch. */
export interface WriteCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

export function noCounts(): WriteCounts {
  return { inserted: 0, updated: 0, unchanged: 0 };
}

/** A `numeric` column takes a string: a float literal would round-trip through binary64. */
export function numericIn(value: number | null | undefined, scale: number): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value.toFixed(scale);
}

/** A `bigint` column in `mode: 'number'`; a non-integral count is a parse problem, not a row. */
export function intIn(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/** Postgres caps a statement at 65 535 bind parameters; every chunk below stays far inside it. */
export const TICK_CHUNK = 200;

/**
 * Insert `quote_ticks` rows that are not already there — STOR-01's "one row per observed change".
 *
 * `quote_ticks` is the one market-data table with no natural key: its primary key is
 * `(capture_ts, tick_id)` and `tick_id` comes from `quote_ticks_id_seq`, so `ON CONFLICT` has
 * nothing to key on and a naive re-run would double every tick. The `NOT EXISTS` guard on
 * `(md_line_id, capture_ts, kind)` is the natural key the table does not declare: a capture already
 * recorded for a line is the same observation, and a replayed capture carries the same
 * `captured_at` for ever, which is what makes a second run of any of these jobs write nothing.
 *
 * The guard's predicate names `capture_ts`, so the planner prunes to the one daily partition.
 *
 * @returns `inserted` and `unchanged`; `updated` is always 0 — a tick is never rewritten.
 */
export async function insertQuoteTicks(
  tx: Tx,
  rows: readonly (CboeQuoteTickRow | CryptoTickRow)[],
  provenanceId: number,
): Promise<WriteCounts> {
  const counts = noCounts();
  for (const row of rows) {
    const res = await tx.execute<{ tick_id: string }>(sql`
      INSERT INTO quote_ticks (capture_ts, instrument_id, md_line_id, kind, source_ts, publish_ts,
                               src_seq, price, bid, ask, bid_size, ask_size, open, high, low,
                               prev_close, volume, iv30, conditions, session_state, provenance_id)
      SELECT ${row.captureTs}::timestamptz, ${row.instrumentId}::bigint, ${row.mdLineId}::bigint,
             ${row.kind}, ${row.sourceTs}::timestamptz, ${row.publishTs ?? null}::timestamptz,
             ${intIn(row.srcSeq ?? null)}::bigint,
             ${numericIn(row.price ?? null, 6)}::numeric,
             ${numericIn(row.bid ?? null, 6)}::numeric,
             ${numericIn(row.ask ?? null, 6)}::numeric,
             ${intIn(row.bidSize ?? null)}::integer,
             ${intIn(row.askSize ?? null)}::integer,
             ${numericIn(row.open ?? null, 6)}::numeric,
             ${numericIn(row.high ?? null, 6)}::numeric,
             ${numericIn(row.low ?? null, 6)}::numeric,
             ${numericIn(row.prevClose ?? null, 6)}::numeric,
             ${intIn(row.volume ?? null)}::bigint,
             ${numericIn(row.iv30 ?? null, 6)}::numeric,
             ${sql.param([...row.conditions])}::text[],
             ${row.sessionState}::session_state,
             ${provenanceId}::bigint
       WHERE NOT EXISTS (
         SELECT 1 FROM quote_ticks q
          WHERE q.md_line_id = ${row.mdLineId}::bigint
            AND q.capture_ts = ${row.captureTs}::timestamptz
            AND q.kind = ${row.kind})
      RETURNING tick_id`);
    if (res.rows.length > 0) counts.inserted += 1;
    else counts.unchanged += 1;
  }
  return counts;
}

/** The `coingecko.simple` tick shape (§5.8) — narrower than Cboe's, same table. */
export interface CryptoTickRow {
  captureTs: string;
  instrumentId: number;
  mdLineId: number;
  kind: string;
  sourceTs: string | null;
  publishTs: string | null;
  price: number | null;
  prevClose: number | null;
  sessionState: SessionState | null;
  conditions: readonly string[];
  srcSeq?: number | null;
  bid?: number | null;
  ask?: number | null;
  bidSize?: number | null;
  askSize?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
  iv30?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ingest_runs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One `ingest_runs` row per execution, `job_id` = the module basename (PROVIDERS §13).
 *
 * When the scheduler drives the job it has already opened the row and passed its `run_id`; the job
 * then writes none, because "one row per execution" is a count, not a convention. Every other
 * caller — a test, `db:seed`, a manual re-run — gets the row from here, on the job's own
 * transaction, so a rolled-back test leaves no trace.
 */
export async function withIngestRun(
  ctx: MarketJobContext,
  job: { id: string; sourceId: string | null },
  run: (runId: number | undefined) => Promise<MarketJobResult>,
): Promise<MarketJobResult> {
  const own = ctx.recordRun ?? ctx.runId === undefined;
  if (!own) return run(ctx.runId);

  const startedAt = new Date(ctx.clock.now());
  const started = await ctx.tx
    .insert(ingestRuns)
    .values({
      jobId: job.id,
      sourceId: job.sourceId,
      startedAt,
      status: 'running',
      traceId: ctx.traceId ?? null,
    })
    .returning({ runId: ingestRuns.runId });
  const runId = started[0]?.runId;
  if (runId === undefined) {
    throw new Error(`ingest_runs insert returned no run_id for ${job.id}`);
  }

  // No try/catch around `run`: a statement that raises aborts this transaction, so the UPDATE
  // below would fail with 25P02 and mask the real error with an "aborted transaction" one. The
  // row was opened inside the same transaction and rolls back with it, which is the honest
  // outcome — a run that could not finish left no record because it left no writes either. When
  // the scheduler owns the row (`ctx.runId` set) it records the failure from its own transaction.
  const result = await run(runId);

  const did = result.fetched + result.inserted + result.updated;
  // The same rule `scheduler.ts#runStatus` applies: `failed` on errors, `skipped` for a run that
  // fetched and wrote nothing but did decline to write something.
  const status =
    result.errors.length > 0 ? 'failed' : did === 0 && result.skipped > 0 ? 'skipped' : 'ok';
  await ctx.tx
    .update(ingestRuns)
    .set({
      status,
      finishedAt: new Date(ctx.clock.now()),
      fetched: result.fetched,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors,
    })
    .where(sql`${ingestRuns.runId} = ${runId}`);

  return result;
}

/** Fold a {@link WriteCounts} into a job result; `unchanged` is what `skipped` reports. */
export function tally(result: MarketJobResult, counts: WriteCounts): MarketJobResult {
  result.inserted += counts.inserted;
  result.updated += counts.updated;
  result.skipped += counts.unchanged;
  return result;
}

/** The `code` a failed fetch carries into `ingest_runs.errors`. */
export function fetchError(err: unknown, url: string): JobError {
  return {
    code: err instanceof Error ? err.name : 'FETCH_FAILED',
    message: err instanceof Error ? err.message : String(err),
    url,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────────────────────

const sessionOf = calendarSessionResolver();

/**
 * The session at `atMs` on `calendarId`, or `undefined` when the calendar is not materialised.
 *
 * `undefined` rather than `'unknown'` is deliberate: PROVIDERS §5.1 gates `PX_OFFICIAL_CLOSE` on
 * `session ∈ {closed, post}` and says "absent means *not stated*, and nothing is published". A
 * process whose calendars have not been seeded must publish no official close at all rather than
 * guess one from the wall clock.
 */
export function sessionAt(atMs: number, calendarId: string): SessionState | undefined {
  const state = sessionOf(atMs, calendarId);
  return state === 'unknown' ? undefined : state;
}

/** The US equities/index calendar the Cboe delayed feed is gated on. */
export const US_EQUITY_CALENDAR = 'XNYS';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job — PROVIDERS §5.1, §13
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CBOE_QUOTES_SOURCE_ID = 'cboe.quotes' satisfies ProviderId;

/** §13: `{everyMs: 10000, jitterMs: 1000, marketHoursOnly: true, offHoursEveryMs: 300000}`. */
export const CBOE_QUOTES_SCHEDULE = {
  everyMs: 10_000,
  jitterMs: 1_000,
  marketHoursOnly: true,
  offHoursEveryMs: 300_000,
} as const;

/**
 * Poll the hot set through `cboe.quotes` (§5.1).
 *
 * One request per md line — the endpoint is per-symbol and there is no batch form — each one its
 * own provenance row, its own `quote_ticks` row and its own plant update. A symbol that fails is an
 * entry in `ingest_runs.errors` and nothing else: the other symbols in the hot set are still polled,
 * because one 404 on a retired ticker must not blank the screen for the rest.
 */
export async function runCboeQuotes(ctx: MarketJobContext): Promise<MarketJobResult> {
  return withIngestRun(ctx, { id: 'cboeQuotes', sourceId: CBOE_QUOTES_SOURCE_ID }, async () => {
    const result = emptyResult();
    const targets = await resolveTargets(ctx, CBOE_QUOTES_SOURCE_ID);
    if (targets.length === 0) {
      ctx.log?.info?.('cboeQuotes.no_targets', { sourceId: CBOE_QUOTES_SOURCE_ID });
      return result;
    }

    const session = sessionAt(ctx.clock.now(), US_EQUITY_CALENDAR);
    const lines = linesOf(targets);

    for (const target of targets) {
      const url = cboeQuoteUrl(target.providerSymbol);
      let raw: RawRecord;
      try {
        raw = await fetchThrough(
          ctx,
          cboeQuotesAdapter,
          { providerSymbol: target.providerSymbol, ...requestEnvelope(ctx) },
          url,
        );
      } catch (err) {
        result.errors.push(fetchError(err, url));
        continue;
      }
      if (raw.status === 304) {
        // §1.3: a revalidation publishes nothing, writes no provenance row and advances no `cap`.
        result.skipped += 1;
        continue;
      }
      result.fetched += 1;

      const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
        raw,
        adapterVersion: CBOE_ADAPTER_VERSION,
        lines,
        // `normaliseQuote` directly, not `adapter.normalise`: the adapter's own path is the
        // zero-knowledge one and deliberately states no session, and §5.1 gates
        // `PX_OFFICIAL_CLOSE` on `session ∈ {closed, post}` — intra-session Cboe sets
        // `close = current_price`, so publishing it without the calendar would invent an official
        // close. The session is the calendar's, and an unmaterialised calendar leaves it unstated.
        normalise: (r, nctx) =>
          normaliseQuote(r, nctx, {
            sourceId: CBOE_QUOTES_SOURCE_ID,
            ...(session === undefined ? {} : { session }),
          }),
      });
      result.provenanceIds.push(provenanceId);
      result.problems.push(...norm.problems);

      result.published += publish(ctx, norm.updates, result.errors);
      tally(result, await insertQuoteTicks(ctx.tx, norm.rows.quoteTicks, provenanceId));
    }

    ctx.log?.info?.('cboeQuotes.done', {
      targets: targets.length,
      fetched: result.fetched,
      inserted: result.inserted,
      session: session ?? 'unstated',
    });
    return result;
  });
}

/** The scheduler row (PROVIDERS §13). `id` is this module's basename. */
export const job = {
  id: 'cboeQuotes',
  schedule: CBOE_QUOTES_SCHEDULE,
  provider: CBOE_QUOTES_SOURCE_ID,
  priority: 1 as const,
  timeoutMs: 10_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runCboeQuotes(ctx),
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The natural-key writers — shared by the seven jobs that import this module
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How many of a chunk's natural keys the table already holds.
 *
 * The counterpart of `RETURNING (xmax = 0)`, which Postgres refuses on a partitioned table
 * (`0A000 cannot retrieve a system column in this context`): `bars_intraday`, `bars_daily` and
 * `option_quotes` are all `PARTITION BY RANGE`, so the branch each row took has to be worked out
 * from what was there a statement earlier rather than from the tuple header.
 */
async function countHeld(tx: Tx, query: SQL): Promise<number> {
  const res = await tx.execute<{ n: number }>(query);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Split a chunk into inserted / updated / unchanged.
 *
 * A key the table did not hold is always inserted, and an insert always comes back from
 * `RETURNING`. A key it did hold comes back only when the `setWhere` predicate found a difference.
 * So `inserted = size − held`, `updated = touched − inserted`, and everything the statement did not
 * return is a row it did not touch.
 */
function classify(counts: WriteCounts, size: number, held: number, touched: number): void {
  const inserted = size - held;
  counts.inserted += inserted;
  counts.updated += Math.max(0, touched - inserted);
  counts.unchanged += size - touched;
}

/** One `bars_intraday` row, as a parser produces it (PROVIDERS §5.5 "Writes"). */
export interface IntradayBarInput {
  instrumentId: number;
  barInterval: string;
  barTs: string;
  mdLineId: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  session: string;
  isFinal: boolean;
  captureTs: string;
}

/**
 * Upsert `bars_intraday` on its primary key `(instrument_id, bar_interval, bar_ts)`.
 *
 * The `WHERE` on the `DO UPDATE` compares every data column except `provenance_id`: re-fetching
 * unchanged bytes is still unchanged data, and a row the predicate rejects is not returned at all,
 * so `unchanged` is exactly what the statement did not touch. `xmax = 0` on a returned row is the
 * only way Postgres will say which branch fired.
 *
 * This is also the `is_final` flip of §5.5: the poll that carries a later `bar_ts` restates the
 * previous last bar with `is_final = true`, which lands here as an `updated`, not an `inserted`.
 */
export async function upsertBarsIntraday(
  tx: Tx,
  rows: readonly IntradayBarInput[],
  provenanceId: number,
): Promise<WriteCounts> {
  const counts = noCounts();
  for (let offset = 0; offset < rows.length; offset += TICK_CHUNK) {
    const chunk = rows.slice(offset, offset + TICK_CHUNK);
    const held = await countHeld(
      tx,
      sql`
        SELECT count(*)::int AS n
          FROM bars_intraday b
          JOIN unnest(${sql.param(chunk.map((r) => r.instrumentId))}::bigint[],
                      ${sql.param(chunk.map((r) => r.barInterval))}::text[],
                      ${sql.param(chunk.map((r) => r.barTs))}::timestamptz[])
               AS k(instrument_id, bar_interval, bar_ts)
            ON b.instrument_id = k.instrument_id
           AND b.bar_interval = k.bar_interval
           AND b.bar_ts = k.bar_ts`,
    );
    const values = chunk.map((r) => ({
      instrumentId: r.instrumentId,
      barInterval: r.barInterval,
      barTs: r.barTs,
      mdLineId: r.mdLineId,
      open: numericIn(r.open, 6),
      high: numericIn(r.high, 6),
      low: numericIn(r.low, 6),
      close: numericIn(r.close, 6) ?? '0',
      volume: intIn(r.volume),
      session: r.session,
      isFinal: r.isFinal,
      captureTs: r.captureTs,
      provenanceId,
    }));
    const returned = await tx
      .insert(barsIntraday)
      .values(values)
      .onConflictDoUpdate({
        target: [barsIntraday.instrumentId, barsIntraday.barInterval, barsIntraday.barTs],
        set: {
          mdLineId: sql`excluded.md_line_id`,
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          session: sql`excluded.session`,
          isFinal: sql`excluded.is_final`,
          captureTs: sql`excluded.capture_ts`,
          provenanceId: sql`excluded.provenance_id`,
        },
        setWhere: sql`(bars_intraday.md_line_id, bars_intraday.open, bars_intraday.high,
                       bars_intraday.low, bars_intraday.close, bars_intraday.volume,
                       bars_intraday.session, bars_intraday.is_final)
                      IS DISTINCT FROM
                      (excluded.md_line_id, excluded.open, excluded.high,
                       excluded.low, excluded.close, excluded.volume,
                       excluded.session, excluded.is_final)`,
      })
      .returning({ instrumentId: barsIntraday.instrumentId });

    classify(counts, chunk.length, held, returned.length);
  }
  return counts;
}

/** One `bars_daily` row. `officialClose` is §5.1's post-close `data.close`, absent intra-session. */
export interface DailyBarInput {
  instrumentId: number;
  sessionDate: string;
  mdLineId: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  officialClose?: number | null;
  srcAdjClose?: number | null;
  sourceTs: string | null;
  captureTs: string;
}

/** Upsert `bars_daily` on `(instrument_id, session_date)` — "one truth row per instrument-day". */
export async function upsertBarsDaily(
  tx: Tx,
  rows: readonly DailyBarInput[],
  provenanceId: number,
): Promise<WriteCounts> {
  const counts = noCounts();
  for (let offset = 0; offset < rows.length; offset += TICK_CHUNK) {
    const chunk = rows.slice(offset, offset + TICK_CHUNK);
    const held = await countHeld(
      tx,
      sql`
        SELECT count(*)::int AS n
          FROM bars_daily b
          JOIN unnest(${sql.param(chunk.map((r) => r.instrumentId))}::bigint[],
                      ${sql.param(chunk.map((r) => r.sessionDate))}::text[])
               AS k(instrument_id, session_date)
            ON b.instrument_id = k.instrument_id
           AND b.session_date = k.session_date::date`,
    );
    const values = chunk.map((r) => ({
      instrumentId: r.instrumentId,
      sessionDate: r.sessionDate,
      mdLineId: r.mdLineId,
      open: numericIn(r.open, 6),
      high: numericIn(r.high, 6),
      low: numericIn(r.low, 6),
      close: numericIn(r.close, 6) ?? '0',
      volume: intIn(r.volume),
      officialClose: numericIn(r.officialClose ?? null, 6),
      srcAdjClose: numericIn(r.srcAdjClose ?? null, 6),
      sourceTs: r.sourceTs,
      captureTs: r.captureTs,
      provenanceId,
    }));
    const returned = await tx
      .insert(barsDaily)
      .values(values)
      .onConflictDoUpdate({
        target: [barsDaily.instrumentId, barsDaily.sessionDate],
        set: {
          mdLineId: sql`excluded.md_line_id`,
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          officialClose: sql`excluded.official_close`,
          srcAdjClose: sql`excluded.src_adj_close`,
          sourceTs: sql`excluded.source_ts`,
          captureTs: sql`excluded.capture_ts`,
          provenanceId: sql`excluded.provenance_id`,
        },
        setWhere: sql`(bars_daily.md_line_id, bars_daily.open, bars_daily.high, bars_daily.low,
                       bars_daily.close, bars_daily.volume, bars_daily.official_close,
                       bars_daily.src_adj_close)
                      IS DISTINCT FROM
                      (excluded.md_line_id, excluded.open, excluded.high, excluded.low,
                       excluded.close, excluded.volume, excluded.official_close,
                       excluded.src_adj_close)`,
      })
      .returning({ instrumentId: barsDaily.instrumentId });

    classify(counts, chunk.length, held, returned.length);
  }
  return counts;
}

/** One `fx_rates` row (§5.7). */
export interface FxRateInput {
  baseCcy: string;
  quoteCcy: string;
  rateDate: string;
  rate: number;
  sourceId: string;
}

/** Upsert `fx_rates` on `(base_ccy, quote_ccy, rate_date, source_id)` — a re-run is a no-op. */
export async function upsertFxRates(
  tx: Tx,
  rows: readonly FxRateInput[],
  provenanceId: number,
): Promise<WriteCounts> {
  const counts = noCounts();
  for (let offset = 0; offset < rows.length; offset += TICK_CHUNK) {
    const chunk = rows.slice(offset, offset + TICK_CHUNK);
    const values = chunk.map((r) => ({
      baseCcy: r.baseCcy,
      quoteCcy: r.quoteCcy,
      rateDate: r.rateDate,
      rate: numericIn(r.rate, 8) ?? '0',
      sourceId: r.sourceId,
      provenanceId,
    }));
    const held = await countHeld(
      tx,
      sql`
        SELECT count(*)::int AS n
          FROM fx_rates f
          JOIN unnest(${sql.param(chunk.map((r) => r.baseCcy))}::text[],
                      ${sql.param(chunk.map((r) => r.quoteCcy))}::text[],
                      ${sql.param(chunk.map((r) => r.rateDate))}::text[],
                      ${sql.param(chunk.map((r) => r.sourceId))}::text[])
               AS k(base_ccy, quote_ccy, rate_date, source_id)
            ON f.base_ccy = k.base_ccy AND f.quote_ccy = k.quote_ccy
           AND f.rate_date = k.rate_date::date AND f.source_id = k.source_id`,
    );
    const returned = await tx
      .insert(fxRates)
      .values(values)
      .onConflictDoUpdate({
        target: [fxRates.baseCcy, fxRates.quoteCcy, fxRates.rateDate, fxRates.sourceId],
        set: { rate: sql`excluded.rate`, provenanceId: sql`excluded.provenance_id` },
        setWhere: sql`fx_rates.rate IS DISTINCT FROM excluded.rate`,
      })
      .returning({ baseCcy: fxRates.baseCcy });

    classify(counts, chunk.length, held, returned.length);
  }
  return counts;
}

/** One `option_quotes` row (§5.2). `instrumentId` is the contract, already resolved or minted. */
export interface OptionQuoteInput {
  captureTs: string;
  instrumentId: number;
  underlyingInstrumentId: number;
  mdLineId: number;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
  lastTs: string | null;
  prevClose: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  rho: number | null;
  theo: number | null;
  underlyingPx: number | null;
}

/** Upsert `option_quotes` on its primary key `(capture_ts, instrument_id)`. */
export async function upsertOptionQuotes(
  tx: Tx,
  rows: readonly OptionQuoteInput[],
  provenanceId: number,
): Promise<WriteCounts> {
  const counts = noCounts();
  for (let offset = 0; offset < rows.length; offset += TICK_CHUNK) {
    const chunk = rows.slice(offset, offset + TICK_CHUNK);
    const values = chunk.map((r) => ({
      captureTs: r.captureTs,
      instrumentId: r.instrumentId,
      underlyingInstrumentId: r.underlyingInstrumentId,
      mdLineId: r.mdLineId,
      bid: numericIn(r.bid, 4),
      ask: numericIn(r.ask, 4),
      bidSize: intIn(r.bidSize),
      askSize: intIn(r.askSize),
      last: numericIn(r.last, 4),
      lastTs: r.lastTs,
      prevClose: numericIn(r.prevClose, 6),
      volume: intIn(r.volume),
      openInterest: intIn(r.openInterest),
      iv: numericIn(r.iv, 6),
      delta: numericIn(r.delta, 6),
      gamma: numericIn(r.gamma, 8),
      vega: numericIn(r.vega, 6),
      theta: numericIn(r.theta, 6),
      rho: numericIn(r.rho, 6),
      theo: numericIn(r.theo, 6),
      underlyingPx: numericIn(r.underlyingPx, 6),
      provenanceId,
    }));
    const held = await countHeld(
      tx,
      sql`
        SELECT count(*)::int AS n
          FROM option_quotes o
          JOIN unnest(${sql.param(chunk.map((r) => r.captureTs))}::timestamptz[],
                      ${sql.param(chunk.map((r) => r.instrumentId))}::bigint[])
               AS k(capture_ts, instrument_id)
            ON o.capture_ts = k.capture_ts AND o.instrument_id = k.instrument_id`,
    );
    const returned = await tx
      .insert(optionQuotes)
      .values(values)
      .onConflictDoUpdate({
        target: [optionQuotes.captureTs, optionQuotes.instrumentId],
        set: {
          underlyingInstrumentId: sql`excluded.underlying_instrument_id`,
          mdLineId: sql`excluded.md_line_id`,
          bid: sql`excluded.bid`,
          ask: sql`excluded.ask`,
          bidSize: sql`excluded.bid_size`,
          askSize: sql`excluded.ask_size`,
          last: sql`excluded.last`,
          lastTs: sql`excluded.last_ts`,
          prevClose: sql`excluded.prev_close`,
          volume: sql`excluded.volume`,
          openInterest: sql`excluded.open_interest`,
          iv: sql`excluded.iv`,
          delta: sql`excluded.delta`,
          gamma: sql`excluded.gamma`,
          vega: sql`excluded.vega`,
          theta: sql`excluded.theta`,
          rho: sql`excluded.rho`,
          theo: sql`excluded.theo`,
          underlyingPx: sql`excluded.underlying_px`,
          provenanceId: sql`excluded.provenance_id`,
        },
        setWhere: sql`(option_quotes.bid, option_quotes.ask, option_quotes.bid_size,
                       option_quotes.ask_size, option_quotes.last, option_quotes.last_ts,
                       option_quotes.prev_close, option_quotes.volume, option_quotes.open_interest,
                       option_quotes.iv, option_quotes.delta, option_quotes.gamma,
                       option_quotes.vega, option_quotes.theta, option_quotes.rho,
                       option_quotes.theo, option_quotes.underlying_px)
                      IS DISTINCT FROM
                      (excluded.bid, excluded.ask, excluded.bid_size,
                       excluded.ask_size, excluded.last, excluded.last_ts,
                       excluded.prev_close, excluded.volume, excluded.open_interest,
                       excluded.iv, excluded.delta, excluded.gamma,
                       excluded.vega, excluded.theta, excluded.rho,
                       excluded.theo, excluded.underlying_px)`,
      })
      .returning({ instrumentId: optionQuotes.instrumentId });

    classify(counts, chunk.length, held, returned.length);
  }
  return counts;
}
