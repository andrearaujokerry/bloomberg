/**
 * `ingest/jobs/blsSeries.ts` — BLS headline series (PROVIDERS.b §10.5, §13).
 *
 * §13: `bls.timeseries`, `'35 8 * * 1-5'` on release days else `'0 9 * * *'`, priority 2, 30 s,
 * "**one POST** carrying every headline series id".
 *
 * ## The quota is the design, not a caveat
 *
 * The keyless v2 tier allows **25 queries a day** and up to 25 series ids per query. A job that
 * fetched per series would spend the day in one run and then serve nothing until midnight — and it
 * would look perfectly healthy while doing it, because BLS answers an exhausted quota with
 * **HTTP 200** and `status: "REQUEST_NOT_PROCESSED"`. Three things follow, and all three are here:
 *
 *  1. {@link runBlsSeries} issues **exactly one** POST per run, carrying every headline series id
 *     in a single `seriesid` array ({@link blsTimeseriesBody} sorts and de-duplicates it, so the
 *     body — and therefore the request key — is a function of the universe, not of insert order).
 *     More than {@link BLS_MAX_SERIES_PER_QUERY} ids is the only thing that makes a second request,
 *     and the run says so in its log.
 *  2. It fetches **at most once per Eastern day** ({@link blsFetchDecision}): a second invocation
 *     inside the same ET day is `skipped` with `ALREADY_POLLED_TODAY` and spends no token. The
 *     evidence is this job's own `ingest_runs` rows, which is what makes a crash loop safe — the
 *     single most likely way to breach a daily quota is a process that restarts every minute.
 *  3. The envelope is a gate: anything but `REQUEST_SUCCEEDED` writes **nothing** and is reported
 *     as a `BLS_REQUEST_NOT_PROCESSED` job error, so the breaker trips and the rest of the day's
 *     quota survives. It is never parsed as "no data".
 *
 * §10.5's schedule — 08:35 ET on a day BLS has a release, 09:00 ET otherwise — is two cron
 * expressions and `IngestJob.schedule` is one, so {@link BLS_SERIES_SCHEDULE} fires at both slots
 * and {@link blsFetchDecision} decides which is this day's: 08:35 only when `econ_release_events`
 * holds a `bls.schedule` event for the ET date, 09:00 unconditionally. A tick at any other minute
 * does nothing. See §18 in the report — the union of two crons is the only deviation here.
 *
 * ## Vintages
 *
 * The vintage rule is **not re-implemented here**. `upsertEconObservations` lives in
 * `fredSeries.ts` — the job that exists for vintage detection — and `fedRates.ts`, `worldMacro.ts`
 * and this job all write through it: a new value for an `obs_date` that already has one flips the
 * old row's `is_latest` and inserts a new row at the capture instant with `status 'revised'`, an
 * unchanged value writes nothing, and a capture that is not newer than the vintage held is
 * dropped. Two writers that disagreed about when a revision opens a vintage would make ECO and GP
 * show different histories for one series depending on which job last touched it.
 *
 * The one thing this job adds to that writer is the **footnote**: BLS is the only source that
 * publishes one per observation (`footnotes[0].text`, §10.5 — *"Data unavailable due to the 2025
 * lapse in appropriations"* on the fixture's 2025-M10 row), and a period that acquired a footnote
 * is a new statement about that period even when the number did not move.
 */

import { sql } from 'drizzle-orm';

import {
  BLS_ADAPTER_VERSION,
  BLS_MAX_SERIES_PER_QUERY,
  BLS_MAX_YEARS_PER_QUERY,
  BLS_TIMESERIES_URL,
  blsTimeseriesBody,
  fetchBlsTimeseries,
} from '../../providers/bls/adapter.js';
import {
  BLS_STATUS_SUCCEEDED,
  blsRequestSucceeded,
  normaliseBlsTimeseries,
} from '../../providers/bls/parse.js';
import { openReplayStore } from '../../providers/replayStore.js';
import { zonedParts } from '../scheduler.js';
import {
  emptyResult,
  fetchError,
  linesOf,
  normaliseWithProvenance,
  publish,
  requestEnvelope,
  resolveTargets,
  withIngestRun,
} from './cboeQuotes.js';
import { recordSeriesFacts, upsertEconObservations } from './fredSeries.js';
import { recordDqEvent } from './secNport.js';

import type { Tx } from '../../db/client.js';
import type { BlsObservationRow, BlsTimeseriesRows } from '../../providers/bls/parse.js';
import type { ProviderId, RawRecord } from '../../providers/types.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';
import type { ObservationCounts, ObservationInput } from './fredSeries.js';

export const BLS_SOURCE_ID = 'bls.timeseries' satisfies ProviderId;
export const BLS_SCHEDULE_SOURCE_ID = 'bls.schedule' satisfies ProviderId;

/**
 * §13's two rows as one cron: 08:35 and 09:00 ET, every day. `blsFetchDecision` turns the four
 * minutes this matches (08:00, 08:35, 09:00, 09:35) into the one slot that is this day's.
 */
export const BLS_SERIES_SCHEDULE = '0,35 8,9 * * *';

/** §10.5: 08:35 ET on a day with a scheduled BLS release. */
export const BLS_RELEASE_SLOT = { hour: 8, minute: 35 } as const;
/** §10.5: 09:00 ET on every other day. */
export const BLS_DEFAULT_SLOT = { hour: 9, minute: 0 } as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function chunked<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Zeroed {@link ObservationCounts}, for a result that accumulates across series. */
export function noObservationCounts(): ObservationCounts {
  return { inserted: 0, revised: 0, unchanged: 0, stale: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The series universe and the daily budget
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `econ_series.provider_code` → `series_id` for one source, ordered so the body is stable. */
export async function econSeriesByProviderCode(
  tx: Tx,
  sourceId: string,
): Promise<Map<string, number>> {
  const res = await tx.execute<{ provider_code: string; series_id: string }>(sql`
    SELECT provider_code, series_id FROM econ_series
     WHERE source_id = ${sourceId}
     ORDER BY provider_code`);
  const map = new Map<string, number>();
  for (const row of res.rows) map.set(row.provider_code, Number(row.series_id));
  return map;
}

/** The ET calendar day of an instant, as `YYYY-MM-DD`. */
export function easternDate(epochMs: number): string {
  const parts = zonedParts(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(parts.year)}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** `true` when `econ_release_events` holds a BLS release scheduled on this ET date (§10.6). */
export async function blsReleaseScheduledOn(tx: Tx, etDate: string): Promise<boolean> {
  const res = await tx.execute<{ any: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
        FROM econ_release_events e
        JOIN econ_releases r ON r.release_id = e.release_id
       WHERE r.source_id = ${BLS_SCHEDULE_SOURCE_ID}
         AND (e.scheduled_at AT TIME ZONE 'America/New_York')::date = ${etDate}::date
         AND e.status IN ('scheduled', 'released', 'revised')) AS any`);
  return res.rows[0]?.any === true;
}

/** `true` when this job has already spent a query on this ET day (§10.5's persisted bucket). */
export async function blsPolledOn(tx: Tx, etDate: string): Promise<boolean> {
  const res = await tx.execute<{ any: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM ingest_runs
       WHERE job_id = 'blsSeries'
         AND fetched > 0
         AND (started_at AT TIME ZONE 'America/New_York')::date = ${etDate}::date) AS any`);
  return res.rows[0]?.any === true;
}

/** Why a run did or did not spend a query. */
export interface BlsFetchDecision {
  fetch: boolean;
  reason: 'RELEASE_SLOT' | 'DEFAULT_SLOT' | 'FORCED' | 'NOT_A_SLOT' | 'ALREADY_POLLED_TODAY';
  etDate: string;
}

/**
 * Whether this tick is the day's one query (§10.5).
 *
 * 08:35 ET spends it only when BLS has a release that day; 09:00 ET spends it unconditionally;
 * every other minute the cron matches is not a slot. Either way a day that has already been polled
 * is never polled again — that gate, not the slot, is what protects the quota across a restart.
 */
export async function blsFetchDecision(
  ctx: Pick<MarketJobContext, 'tx' | 'clock'>,
  options: { force?: boolean } = {},
): Promise<BlsFetchDecision> {
  const now = ctx.clock.now();
  const etDate = easternDate(now);
  if (options.force === true) return { fetch: true, reason: 'FORCED', etDate };
  if (await blsPolledOn(ctx.tx, etDate)) {
    return { fetch: false, reason: 'ALREADY_POLLED_TODAY', etDate };
  }
  const parts = zonedParts(now);
  if (parts.hour === BLS_DEFAULT_SLOT.hour && parts.minute === BLS_DEFAULT_SLOT.minute) {
    return { fetch: true, reason: 'DEFAULT_SLOT', etDate };
  }
  if (parts.hour === BLS_RELEASE_SLOT.hour && parts.minute === BLS_RELEASE_SLOT.minute) {
    return (await blsReleaseScheduledOn(ctx.tx, etDate))
      ? { fetch: true, reason: 'RELEASE_SLOT', etDate }
      : { fetch: false, reason: 'NOT_A_SLOT', etDate };
  }
  return { fetch: false, reason: 'NOT_A_SLOT', etDate };
}

/** The `{startYear, endYear}` window of §10.5: ten years back, inclusive, from an ET date. */
export function blsYearWindow(etDate: string): { startYear: number; endYear: number } {
  const endYear = Number(etDate.slice(0, 4));
  return { startYear: endYear - (BLS_MAX_YEARS_PER_QUERY - 1), endYear };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one POST, through the adapter when a client is wired and through the replay store otherwise.
 *
 * The replay path is not a fallback to the network: `ReplayStore.replay` throws on a key it does
 * not hold (PROVIDERS.a §3.6). The **body** participates in the key, so the id list and the year
 * window are as much part of the request identity as the URL is.
 */
export async function fetchBlsPost(
  ctx: MarketJobContext,
  req: { seriesIds: readonly string[]; startYear: number; endYear: number },
): Promise<RawRecord> {
  if (ctx.http !== undefined) {
    return fetchBlsTimeseries(ctx.http, { ...req, ...requestEnvelope(ctx) });
  }
  const store = ctx.replay ?? openReplayStore();
  return store.replay({
    providerId: BLS_SOURCE_ID,
    method: 'POST',
    url: BLS_TIMESERIES_URL,
    body: blsTimeseriesBody({ ...req }),
  });
}

/** Raised when BLS answers 200 with anything but `REQUEST_SUCCEEDED` (§10.5). */
export class BlsRequestNotProcessedError extends Error {
  constructor(
    readonly blsStatus: string,
    readonly messages: readonly string[],
  ) {
    super(
      `bls.timeseries answered HTTP 200 with status '${blsStatus}' ` +
        `(expected '${BLS_STATUS_SUCCEEDED}'): ${
          messages.length === 0 ? 'no message' : messages.join('; ')
        } — the daily quota is exhausted or a series id is bad; nothing is written and no ` +
        'further query is spent today (PROVIDERS §10.5)',
    );
    this.name = 'BlsRequestNotProcessedError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface BlsSeriesOptions {
  /** Bypass the slot and the daily gate. For a seed backfill and for a replay test. */
  force?: boolean;
  /** Override the ten-year window — the recorded capture was taken with 2024-2026. */
  window?: { startYear: number; endYear: number };
  /** Poll only these provider codes; default is every `bls.timeseries` series in the database. */
  providerCodes?: readonly string[];
}

export interface BlsSeriesResult extends MarketJobResult {
  decision: BlsFetchDecision;
  /** How many POSTs this run issued. One, unless the universe exceeds 25 ids. */
  requests: number;
  /** The series ids carried in the request, in body order. */
  seriesIds: string[];
  observations: ObservationCounts;
  /** Series the payload carried no observation for (§10.5 `field_population`, `warn`). */
  emptySeries: string[];
}

function emptyBlsResult(decision: BlsFetchDecision): BlsSeriesResult {
  return {
    ...emptyResult(),
    decision,
    requests: 0,
    seriesIds: [],
    observations: noObservationCounts(),
    emptySeries: [],
  };
}

/**
 * Poll every headline BLS series in one POST and write the vintaged observations.
 *
 * The join is `econ_series.provider_code` (§10.5): a series id the database does not know is not
 * invented here, it is dropped with an `unknown_symbol` `dq_event`, because `econ_series` is
 * seeded (WP-15) and a code arriving from BLS that nothing asked for means the request was built
 * from something other than the database.
 */
export async function runBlsSeries(
  ctx: MarketJobContext,
  options: BlsSeriesOptions = {},
): Promise<BlsSeriesResult> {
  const decision = await blsFetchDecision(ctx, options);
  const outer = await withIngestRun(ctx, { id: 'blsSeries', sourceId: BLS_SOURCE_ID }, async () => {
    const result = emptyBlsResult(decision);
    if (!decision.fetch) {
      result.skipped += 1;
      ctx.log?.info?.('blsSeries.skipped', { reason: decision.reason, etDate: decision.etDate });
      return result;
    }

    const known = await econSeriesByProviderCode(ctx.tx, BLS_SOURCE_ID);
    const codes =
      options.providerCodes === undefined
        ? [...known.keys()]
        : [...options.providerCodes].filter((code) => known.has(code));
    if (codes.length === 0) {
      result.skipped += 1;
      ctx.log?.info?.('blsSeries.no_series', { sourceId: BLS_SOURCE_ID });
      return result;
    }

    const window = options.window ?? blsYearWindow(decision.etDate);
    // §10.5: 25 ids per query. The headline set is far smaller, so this is one batch in practice
    // and the loop exists so a larger universe degrades into two queries instead of failing.
    const batches = chunked([...new Set(codes)].sort(), BLS_MAX_SERIES_PER_QUERY);
    const targets = await resolveTargets(ctx, BLS_SOURCE_ID, { instrumentIds: null });
    const lines = linesOf(targets);

    for (const batch of batches) {
      const request = { seriesIds: batch, ...window };
      result.seriesIds.push(...blsBodySeriesIds(request));

      let raw: RawRecord;
      try {
        raw = await fetchBlsPost(ctx, request);
      } catch (err) {
        result.errors.push(fetchError(err, BLS_TIMESERIES_URL));
        return result;
      }
      result.requests += 1;
      if (raw.status === 304) {
        result.skipped += 1;
        continue;
      }
      result.fetched += 1;

      // The envelope gate runs on the parse alone, BEFORE any provenance row is written: a
      // refused request published nothing, so it must leave no trace but the job error.
      const probe = normaliseBlsTimeseries(raw, {
        provenanceId: 0,
        capturedAt: raw.capturedAt,
        lines: new Map(),
      });
      if (!blsRequestSucceeded(probe.rows)) {
        const err = new BlsRequestNotProcessedError(probe.rows.status, probe.rows.messages);
        result.errors.push({
          code: 'BLS_REQUEST_NOT_PROCESSED',
          message: err.message,
          url: BLS_TIMESERIES_URL,
          requestKey: raw.requestKey,
        });
        await recordDqEvent(ctx.tx, {
          kind: 'poll_anomaly',
          severity: 'error',
          sourceId: BLS_SOURCE_ID,
          subject: 'bls.timeseries',
          key: `${decision.etDate}:${probe.rows.status}`,
          details: { status: probe.rows.status, messages: probe.rows.messages },
        });
        return result;
      }

      const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
        raw,
        adapterVersion: BLS_ADAPTER_VERSION,
        lines,
        normalise: (r, nctx) => normaliseBlsTimeseries(r, nctx),
      });
      result.provenanceIds.push(provenanceId);
      result.problems.push(...norm.problems);
      result.published += publish(ctx, norm.updates, result.errors);

      // BLS's own warnings ride the envelope even on success (§10.5).
      if (norm.rows.messages.length > 0) {
        await recordDqEvent(ctx.tx, {
          kind: 'field_population',
          severity: 'warn',
          sourceId: BLS_SOURCE_ID,
          subject: 'bls.timeseries',
          key: `${decision.etDate}:messages`,
          details: { messages: norm.rows.messages },
        });
      }

      await writeBlsRows(ctx, {
        rows: norm.rows,
        known,
        requested: batch,
        vintageAt: new Date(raw.capturedAt),
        provenanceId,
        etDate: decision.etDate,
        result,
      });
    }

    ctx.log?.info?.('blsSeries.done', {
      requests: result.requests,
      series: result.seriesIds.length,
      inserted: result.observations.inserted,
      revised: result.observations.revised,
      unchanged: result.observations.unchanged,
      empty: result.emptySeries.length,
    });
    return result;
  });
  return outer as BlsSeriesResult;
}

/** The series ids in body order — the order the request key is computed over. */
export function blsBodySeriesIds(req: {
  seriesIds: readonly string[];
  startYear: number;
  endYear: number;
}): string[] {
  const body: unknown = JSON.parse(blsTimeseriesBody(req));
  const ids = (body as { seriesid?: unknown }).seriesid;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

async function writeBlsRows(
  ctx: MarketJobContext,
  args: {
    rows: BlsTimeseriesRows;
    known: ReadonlyMap<string, number>;
    requested: readonly string[];
    vintageAt: Date;
    provenanceId: number;
    etDate: string;
    result: BlsSeriesResult;
  },
): Promise<void> {
  const { rows, known, requested, result } = args;

  const bySeries = new Map<number, ObservationInput[]>();
  const span = new Map<string, { first: string; last: string }>();
  const seen = new Set<string>();

  for (const obs of rows.observations) {
    const seriesId = known.get(obs.providerCode);
    if (seriesId === undefined) {
      if (!seen.has(obs.providerCode)) {
        seen.add(obs.providerCode);
        await recordDqEvent(ctx.tx, {
          // `dq_events.kind` has no `unknown_symbol` member (CONTRACTS L319); a series id we
          // never asked for arriving in the answer is an anomaly of the poll itself.
          kind: 'poll_anomaly',
          severity: 'warn',
          sourceId: BLS_SOURCE_ID,
          subject: `e:${obs.providerCode}`,
          key: obs.providerCode,
          details: { providerCode: obs.providerCode, reason: 'no econ_series row' },
        });
      }
      continue;
    }
    const list = bySeries.get(seriesId) ?? [];
    list.push(econObsFromBls(obs));
    bySeries.set(seriesId, list);
    const held = span.get(obs.providerCode);
    span.set(obs.providerCode, {
      first: held === undefined || obs.obsDate < held.first ? obs.obsDate : held.first,
      last: held === undefined || obs.obsDate > held.last ? obs.obsDate : held.last,
    });
  }

  // One call per series: `upsertEconObservations` reads the vintages it holds for that series
  // in one query, so grouping here is what keeps the round trips proportional to the series
  // count rather than to the observation count.
  for (const [seriesId, inputs] of [...bySeries].sort((a, b) => a[0] - b[0])) {
    const counts = await upsertEconObservations(ctx.tx, seriesId, inputs, {
      provenanceId: args.provenanceId,
      capturedAt: args.vintageAt.getTime(),
    });
    result.observations.inserted += counts.inserted;
    result.observations.revised += counts.revised;
    result.observations.unchanged += counts.unchanged;
    result.observations.stale += counts.stale;
    result.inserted += counts.inserted;
    result.updated += counts.revised;
    result.skipped += counts.unchanged + counts.stale;
  }

  for (const [code, s] of [...span].sort()) {
    const seriesId = known.get(code);
    if (seriesId === undefined) continue;
    await recordSeriesFacts(ctx.tx, seriesId, {
      firstObsDate: s.first,
      lastObsDate: s.last,
      capturedAt: args.vintageAt.getTime(),
    });
  }

  // §10.5: a series that came back with no observations while the envelope succeeded is a
  // `field_population` warning, not silence — the id is probably wrong and nobody would notice.
  for (const code of requested) {
    if (span.has(code)) continue;
    result.emptySeries.push(code);
    await recordDqEvent(ctx.tx, {
      kind: 'field_population',
      severity: 'warn',
      sourceId: BLS_SOURCE_ID,
      subject: `e:${code}`,
      key: `${args.etDate}:${code}`,
      details: { providerCode: code, reason: 'REQUEST_SUCCEEDED with zero observations' },
    });
  }
}

/**
 * One parsed BLS observation → one {@link ObservationInput}.
 *
 * `footnote` is carried through, which is the only thing BLS publishes per observation that no
 * other econ source does: the fixture's 2025-M10 row is `'-'` with *"Data unavailable due to the
 * 2025 lapse in appropriations"*, and dropping that text would leave a bare NULL on the chart
 * with nothing to say why.
 */
export function econObsFromBls(obs: BlsObservationRow): ObservationInput {
  return {
    obsDate: obs.obsDate,
    value: obs.value,
    status: obs.status,
    footnote: obs.footnote,
  };
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'blsSeries',
  schedule: BLS_SERIES_SCHEDULE,
  provider: BLS_SOURCE_ID,
  priority: 2 as const,
  timeoutMs: 30_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runBlsSeries(ctx),
};
