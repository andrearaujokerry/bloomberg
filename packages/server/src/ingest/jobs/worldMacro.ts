/**
 * `ingest/jobs/worldMacro.ts` — World Bank and IMF annual macro (PROVIDERS.b §10.7, §10.8, §13).
 *
 * §13: `worldbank` + `imf.datamapper`, `'0 4 * * 0'`, priority 3, 600 s, "the seeded indicator ×
 * country list". Two sources, one job, because they answer the same question — annual global macro
 * — and neither is worth a scheduler row of its own at one poll a week.
 *
 * ## The vintage rule is not re-implemented here
 *
 * Both halves write `econ_observations` through `fredSeries.ts`'s `upsertEconObservations`, which
 * is this package's **one** vintage rule and is shared by `fedRates.ts` and `blsSeries.ts` too: a
 * new value for an `obs_date` that already has one flips the old row's `is_latest` and inserts a
 * new row at the capture instant; an unchanged value writes nothing; a capture no newer than the
 * vintage held is dropped. Two upserts that disagreed about when a revision opens a vintage would
 * make ECO and GP show different histories for one series depending on which job last touched it
 * — and the World Bank revises its back series every July, so this is the ordinary case here, not
 * an edge.
 *
 * `vintage_at` is the **capture instant**, never the wall clock, so replaying one capture twice
 * produces one vintage.
 *
 * ## What the two sources actually give
 *
 * **World Bank** (§10.7) answers `[meta, data[]]` and publishes the series metadata *inside* the
 * observation rows, so one request carries both `econ_series` and `econ_observations`. The paging
 * control is in `meta`: the walk is ascending and capped at {@link WORLDBANK_MAX_PAGES}, and it
 * stops at `meta.pages` rather than walking until a short page, because a 404 costs a token. An
 * HTTP-200 error is a **one**-element array, which {@link worldBankPayloadOk} rejects; nothing is
 * written for a payload that fails it.
 *
 * **IMF** (§10.8) splits the two: `/indicators` is the catalogue (`econ_series`) and
 * `/{ID}/{ISO3}` is the observations. **PROVIDERS §16.9: the observations endpoint has no recorded
 * capture.** So {@link runWorldMacro} asks the replay store whether it holds the key before
 * requesting it and reports `NO_CAPTURE` when it does not; in `live`/`record` mode (`ctx.http`
 * wired) it always requests. That is the documented state of this endpoint, not a fallback: the
 * replay wall is never crossed and no IMF observation is invented in its absence.
 *
 * WEO values for a year beyond the capture's own are **forecasts** and are stored with
 * `status 'preliminary'` — the parser decides that, and it is the difference between a forecast and
 * an actual on a screen.
 */

import { sql } from 'drizzle-orm';

import {
  IMF_ADAPTER_VERSION,
  IMF_INDICATORS_URL,
  fetchImf,
  imfUrl,
} from '../../providers/imf/adapter.js';
import { normaliseImf } from '../../providers/imf/parse.js';
import { openReplayStore, requestKey } from '../../providers/replayStore.js';
import {
  WORLDBANK_ADAPTER_VERSION,
  WORLDBANK_MAX_PAGES,
  WORLDBANK_PER_PAGE,
  fetchWorldBank,
  worldBankUrl,
} from '../../providers/worldbank/adapter.js';
import { normaliseWorldBank, worldBankPayloadOk } from '../../providers/worldbank/parse.js';
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
import { noObservationCounts } from './blsSeries.js';
import {
  ensureEconSeries,
  recordSeriesFacts,
  upsertEconObservations,
} from './fredSeries.js';
import { recordDqEvent } from './secNport.js';

import type { Tx } from '../../db/client.js';
import type { ImfObservationRow, ImfRows } from '../../providers/imf/parse.js';
import type { ProviderId, RawRecord } from '../../providers/types.js';
import type {
  WorldBankObservationRow,
  WorldBankRows,
} from '../../providers/worldbank/parse.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';
import type { ObservationCounts, ObservationInput } from './fredSeries.js';

export const WORLDBANK_SOURCE_ID = 'worldbank' satisfies ProviderId;
export const IMF_SOURCE_ID = 'imf.datamapper' satisfies ProviderId;

/** §13 `worldMacro`: Sunday 04:00 America/New_York. */
export const WORLD_MACRO_SCHEDULE = '0 4 * * 0';

/** §10.8: the IMF publishes the WEO under this dataset; it becomes the `econ_releases` row. */
export const IMF_WEO_RELEASE_NAME = 'IMF World Economic Outlook';

/**
 * The indicator × country pair §10.7 names and the only one with a recorded capture. It is the
 * default **target list**, not a default answer: when `econ_series` already holds `worldbank`
 * rows, those are the targets and this constant is never read.
 */
export const WORLDBANK_DEFAULT_TARGETS: readonly WorldBankTarget[] = [
  { indicator: 'NY.GDP.MKTP.CD', country: 'US' },
];

/**
 * The WEO headline indicators, used only when nothing is seeded. Real GDP growth, nominal GDP and
 * GDP per capita, inflation, unemployment and gross public debt — the six the catalogue's own
 * ordering leads with and the six a macro screen asks for. Named here rather than harvested
 * because the catalogue holds 132 and creating 132 `econ_series` rows nobody asked for would be
 * inventing a universe.
 */
export const IMF_WEO_HEADLINE_INDICATORS: readonly string[] = [
  'GGXWDG_NGDP',
  'LUR',
  'NGDPD',
  'NGDPDPC',
  'NGDP_RPCH',
  'PCPIPCH',
];

/** §10.8's area is ISO-3 while `econ_series.country` is ISO-2, so a target carries both. */
export const IMF_DEFAULT_AREA = { area: 'USA', country: 'US' } as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Targets
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface WorldBankTarget {
  /** `econ_series.provider_code` — `'NY.GDP.MKTP.CD'`. */
  indicator: string;
  /** ISO-2, used verbatim in the path (§10.7 accepts an aggregate code such as `'WLD'` too). */
  country: string;
}

export interface ImfTarget {
  /** `econ_series.provider_code` — `'NGDP_RPCH'`. */
  indicator: string;
  /** ISO-3 (`'USA'`), as the observations endpoint spells it. */
  area: string;
  /** ISO-2 (`'US'`) for `econ_series.country`. */
  country: string;
}

/** `(provider_code, country)` of every seeded series of a source, ordered for a stable walk. */
export async function seededTargets(
  tx: Tx,
  sourceId: string,
): Promise<{ indicator: string; country: string }[]> {
  const res = await tx.execute<{ provider_code: string; country: string }>(sql`
    SELECT provider_code, country FROM econ_series
     WHERE source_id = ${sourceId}
     ORDER BY provider_code`);
  return res.rows.map((row) => ({ indicator: row.provider_code, country: row.country }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// econ_releases / econ_series
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link upsertEconRelease} did: the row's id, and whether this call changed anything. */
export interface EconReleaseUpsert {
  releaseId: number;
  /** `true` when the row was created or genuinely restated; `false` when it already said this. */
  written: boolean;
}

/**
 * Get-or-create one `econ_releases` row, returning its id and whether it changed.
 *
 * The `WHERE … IS DISTINCT FROM` guard is the same one `econCalendar.ts`'s `upsertReleaseEvents`
 * and `upsertFomcMeetings` carry, and it is here for the same two reasons. **Dead tuples:** this
 * function is called once per release by a *daily* calendar poll and a *weekly* macro poll, so an
 * unconditional `DO UPDATE` rewrote all 47 `econ_releases` rows every night for values that never
 * changed — 47 dead tuples a night, and a `ctid`/`xmin` that stopped being evidence of when the
 * release was last restated. **Honest counters:** with no guard, `RETURNING release_id` answered
 * on every call, so a caller could not tell a poll that learned something from one that did not.
 *
 * A guarded `DO UPDATE` whose `WHERE` is false returns **no row at all**, so the id is then read
 * back with the `SELECT` fallback `ensureEconSeries` already uses.
 */
export async function upsertEconRelease(
  tx: Tx,
  row: { sourceId: string; providerReleaseId: string; name: string; country: string; url: string | null },
): Promise<EconReleaseUpsert> {
  const res = await tx.execute<{ release_id: string }>(sql`
    INSERT INTO econ_releases (source_id, provider_release_id, name, country, url, importance)
    VALUES (${row.sourceId}, ${row.providerReleaseId}, ${row.name}, ${row.country}, ${row.url}, 3)
    ON CONFLICT (source_id, provider_release_id) DO UPDATE
       SET name = EXCLUDED.name,
           url = COALESCE(EXCLUDED.url, econ_releases.url)
     WHERE econ_releases.name IS DISTINCT FROM EXCLUDED.name
        OR (econ_releases.url IS NULL AND EXCLUDED.url IS NOT NULL)
    RETURNING release_id`);
  const changed = res.rows[0];
  if (changed !== undefined) return { releaseId: Number(changed.release_id), written: true };

  const held = await tx.execute<{ release_id: string }>(sql`
    SELECT release_id FROM econ_releases
     WHERE source_id = ${row.sourceId} AND provider_release_id = ${row.providerReleaseId}`);
  const heldRow = held.rows[0];
  if (heldRow === undefined) {
    throw new Error(
      `econ_releases row for ${row.sourceId}/${row.providerReleaseId} is absent immediately ` +
        'after an INSERT … ON CONFLICT that wrote nothing — the unique key ' +
        '(source_id, provider_release_id) moved',
    );
  }
  return { releaseId: Number(heldRow.release_id), written: false };
}

/**
 * Attach a series to its release, once.
 *
 * `COALESCE` rather than an overwrite: `ensureEconSeries` leaves the descriptive columns to
 * whoever created the row (§10.1's reasoning — "a poll has nothing better to say about them"),
 * and the same holds for the release a seed deliberately pointed a series at.
 */
export async function linkEconSeriesRelease(
  tx: Tx,
  seriesId: number,
  releaseId: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE econ_series SET release_id = ${releaseId}::bigint
     WHERE series_id = ${seriesId}::bigint AND release_id IS NULL`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface WorldMacroOptions {
  /** Default: the seeded `worldbank` series, else {@link WORLDBANK_DEFAULT_TARGETS}. */
  worldBank?: readonly WorldBankTarget[] | null;
  /** Default: the seeded `imf.datamapper` series, else {@link IMF_WEO_HEADLINE_INDICATORS}. */
  imf?: readonly ImfTarget[] | null;
  /** §10.7's page size. The recorded capture was taken with 3, production uses 100. */
  perPage?: number;
  /** Cap on the page walk; never more than {@link WORLDBANK_MAX_PAGES}. */
  maxPages?: number;
}

export interface SourceReport {
  requests: number;
  series: number;
  observations: ObservationCounts;
  /** Requests not made because the replay store holds no capture (§16.9). */
  noCapture: string[];
}

export interface WorldMacroResult extends MarketJobResult {
  worldBank: SourceReport;
  imf: SourceReport;
}

/** The union of two observation spans; the accumulator may be `null` on the first page. */
export interface ObsSpan {
  first: string;
  last: string;
}

function mergeSpan(held: ObsSpan | null, page: ObsSpan | null): ObsSpan | null {
  if (page === null) return held;
  if (held === null) return page;
  return {
    first: page.first < held.first ? page.first : held.first,
    last: page.last > held.last ? page.last : held.last,
  };
}

function emptyReport(): SourceReport {
  return { requests: 0, series: 0, observations: noObservationCounts(), noCapture: [] };
}

function emptyMacroResult(): WorldMacroResult {
  return { ...emptyResult(), worldBank: emptyReport(), imf: emptyReport() };
}

function foldCounts(
  report: SourceReport,
  result: WorldMacroResult,
  counts: ObservationCounts,
): void {
  report.observations.inserted += counts.inserted;
  report.observations.revised += counts.revised;
  report.observations.unchanged += counts.unchanged;
  report.observations.stale += counts.stale;
  result.inserted += counts.inserted;
  result.updated += counts.revised;
  result.skipped += counts.unchanged + counts.stale;
}

/** `true` when a GET for this URL can be answered without a socket (replay) or at all (live). */
function canFetch(ctx: MarketJobContext, providerId: ProviderId, url: string): boolean {
  if (ctx.http !== undefined) return true;
  const store = ctx.replay ?? openReplayStore();
  return store.has(requestKey(providerId, 'GET', url));
}

async function fetchGet(
  ctx: MarketJobContext,
  providerId: ProviderId,
  url: string,
  live: () => Promise<RawRecord>,
): Promise<RawRecord> {
  if (ctx.http !== undefined) return live();
  const store = ctx.replay ?? openReplayStore();
  return store.replay({ providerId, url });
}

/**
 * Poll the World Bank and the IMF and write `econ_series` + `econ_observations`.
 *
 * A failure on one target costs that target: the error is reported on the result and the walk goes
 * on, because a weekly job that abandoned 40 indicators over one 500 would leave the macro screens
 * a week stale for a reason nobody would see until Monday.
 */
export async function runWorldMacro(
  ctx: MarketJobContext,
  options: WorldMacroOptions = {},
): Promise<WorldMacroResult> {
  const outer = await withIngestRun(
    ctx,
    { id: 'worldMacro', sourceId: WORLDBANK_SOURCE_ID },
    async () => {
      const result = emptyMacroResult();
      await runWorldBankHalf(ctx, options, result);
      await runImfHalf(ctx, options, result);
      ctx.log?.info?.('worldMacro.done', {
        worldBankRequests: result.worldBank.requests,
        worldBankSeries: result.worldBank.series,
        imfRequests: result.imf.requests,
        imfSeries: result.imf.series,
        imfNoCapture: result.imf.noCapture.length,
        inserted: result.inserted,
        revised: result.worldBank.observations.revised + result.imf.observations.revised,
      });
      return result;
    },
  );
  return outer as WorldMacroResult;
}

// ── World Bank ──────────────────────────────────────────────────────────────────────────────

async function runWorldBankHalf(
  ctx: MarketJobContext,
  options: WorldMacroOptions,
  result: WorldMacroResult,
): Promise<void> {
  const seeded = await seededTargets(ctx.tx, WORLDBANK_SOURCE_ID);
  const targets =
    options.worldBank === undefined
      ? seeded.length > 0
        ? seeded
        : WORLDBANK_DEFAULT_TARGETS
      : (options.worldBank ?? []);
  if (targets.length === 0) {
    result.skipped += 1;
    return;
  }

  const perPage = options.perPage ?? WORLDBANK_PER_PAGE;
  const maxPages = Math.min(options.maxPages ?? WORLDBANK_MAX_PAGES, WORLDBANK_MAX_PAGES);
  const lines = linesOf(await resolveTargets(ctx, WORLDBANK_SOURCE_ID, { instrumentIds: null }));

  for (const target of targets) {
    let page = 1;
    let pages = 1;
    let seriesId: number | null = null;
    let span: ObsSpan | null = null;
    // The newest capture instant of the pages actually walked — what `vintage_at` and
    // `econ_series.last_updated_at` are stamped from. Never the wall clock.
    let capturedAt: number | null = null;

    while (page <= Math.min(pages, maxPages)) {
      const request = { country: target.country, indicator: target.indicator, page, perPage };
      const url = worldBankUrl(request);

      // §16.9's rule, which the IMF half already applies to its values endpoint: a page the
      // replay store does not hold is a **capture gap**, not a job failure. The recorded walk was
      // taken at `per_page=3` and stops at page 1 of 22, so an unguarded walk turned every run in
      // a replay-backed environment into `status 'failed'` while it had written everything it
      // could. In live/record mode `canFetch` is always true and nothing is skipped.
      if (!canFetch(ctx, WORLDBANK_SOURCE_ID, url)) {
        result.worldBank.noCapture.push(url);
        ctx.log?.info?.('worldMacro.worldbank_no_capture', { url });
        break;
      }

      // Counted before the call, so a request that missed is still a request that was made: the
      // reported count and the store's call count cannot disagree.
      result.worldBank.requests += 1;
      let raw: RawRecord;
      try {
        raw = await fetchGet(ctx, WORLDBANK_SOURCE_ID, url, () =>
          fetchWorldBank(ctx.http!, { ...request, ...requestEnvelope(ctx) }),
        );
      } catch (err) {
        result.errors.push(fetchError(err, url));
        break;
      }
      if (raw.status === 304) {
        result.skipped += 1;
        break;
      }
      result.fetched += 1;

      const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
        raw,
        adapterVersion: WORLDBANK_ADAPTER_VERSION,
        lines,
        normalise: (r, nctx) => normaliseWorldBank(r, nctx),
      });
      result.provenanceIds.push(provenanceId);
      result.problems.push(...norm.problems);

      if (!worldBankPayloadOk(norm.rows)) {
        // §10.7 trap 1: an error is a one-element array with HTTP 200. Nothing is written.
        result.errors.push({
          code: 'WORLDBANK_PAYLOAD_NOT_A_TUPLE',
          message:
            `worldbank answered HTTP ${raw.status} with a payload that is not a [meta, data] ` +
            `tuple for ${target.indicator} / ${target.country}; nothing written (§10.7)`,
          url,
        });
        await recordDqEvent(ctx.tx, {
          kind: 'poll_anomaly',
          severity: 'error',
          sourceId: WORLDBANK_SOURCE_ID,
          subject: `e:${target.indicator}`,
          key: `${target.indicator}:${target.country}:page${String(page)}`,
          details: { indicator: target.indicator, country: target.country, page },
        });
        break;
      }

      result.published += publish(ctx, norm.updates, result.errors);
      pages = norm.rows.meta?.pages ?? 1;

      const written = await writeWorldBankPage(ctx, {
        rows: norm.rows,
        target,
        provenanceId,
        vintageAt: new Date(raw.capturedAt),
      });
      if (written === null) break;
      seriesId = written.seriesId;
      foldCounts(result.worldBank, result, written.counts);
      span = mergeSpan(span, written.span);
      capturedAt = capturedAt === null ? raw.capturedAt : Math.max(capturedAt, raw.capturedAt);
      page += 1;
    }

    if (seriesId !== null) {
      result.worldBank.series += 1;
      if (span !== null && capturedAt !== null) {
        await guardAgainstShrinkingHistory(ctx, {
          sourceId: WORLDBANK_SOURCE_ID,
          seriesId,
          providerCode: target.indicator,
          lastObsDate: span.last,
        });
        // The capture instant of the newest page walked, never `ctx.clock.now()`: this column is
        // what a screen reads to say when the series was last refreshed, and the wall clock made
        // two runs over identical bytes disagree — ANAL-08's byte-identical property, lost for
        // the one source that used it. Every other caller of `recordSeriesFacts` in this package
        // passes `raw.capturedAt`; this one now does too.
        await recordSeriesFacts(ctx.tx, seriesId, {
          firstObsDate: span.first,
          lastObsDate: span.last,
          capturedAt,
        });
      }
    }
  }
}

async function writeWorldBankPage(
  ctx: MarketJobContext,
  args: {
    rows: WorldBankRows;
    target: WorldBankTarget;
    provenanceId: number;
    vintageAt: Date;
  },
): Promise<{ seriesId: number; counts: ObservationCounts; span: ObsSpan | null } | null> {
  const facts = args.rows.series.find((s) => s.providerCode === args.target.indicator);
  if (facts === undefined) return null;

  const release = await upsertEconRelease(ctx.tx, {
    sourceId: WORLDBANK_SOURCE_ID,
    providerReleaseId: 'WDI',
    name: 'World Development Indicators',
    country: facts.country,
    url: null,
  });
  const seriesId = await ensureEconSeries(ctx.tx, {
    seriesCode: facts.providerCode,
    sourceId: WORLDBANK_SOURCE_ID,
    providerCode: facts.providerCode,
    name: facts.name,
    // §10.7: `unit` is published empty for most indicators; the label carries the unit instead.
    units: facts.units ?? facts.name,
    frequency: 'A',
    seasonalAdj: null,
    country: facts.country,
    decimals: facts.decimals ?? 2,
  });
  await linkEconSeriesRelease(ctx.tx, seriesId, release.releaseId);

  const mine = args.rows.observations.filter(
    (o) => o.providerCode === args.target.indicator && o.country === facts.country,
  );
  const counts = await upsertEconObservations(ctx.tx, seriesId, mine.map(econObsFromWorldBank), {
    provenanceId: args.provenanceId,
    capturedAt: args.vintageAt.getTime(),
  });
  const dates = mine.map((o) => o.obsDate).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  return {
    seriesId,
    counts,
    span: first === undefined || last === undefined ? null : { first, last },
  };
}

/** §10.7's status vocabulary is the publisher's; only `'missing'` and `'preliminary'` occur. */
function econStatus(raw: string): ObservationInput['status'] {
  return raw === 'missing' || raw === 'preliminary' || raw === 'revised' ? raw : 'final';
}

export function econObsFromWorldBank(obs: WorldBankObservationRow): ObservationInput {
  return { obsDate: obs.obsDate, value: obs.value, status: econStatus(obs.status) };
}

/** §10.7: "a series whose latest year goes backwards → `poll_anomaly`". */
async function guardAgainstShrinkingHistory(
  ctx: MarketJobContext,
  args: { sourceId: string; seriesId: number; providerCode: string; lastObsDate: string },
): Promise<void> {
  const res = await ctx.tx.execute<{ last_obs_date: string | null }>(sql`
    SELECT last_obs_date::text AS last_obs_date FROM econ_series
     WHERE series_id = ${args.seriesId}::bigint`);
  const held = res.rows[0]?.last_obs_date ?? null;
  if (held === null || held <= args.lastObsDate) return;
  await recordDqEvent(ctx.tx, {
    kind: 'poll_anomaly',
    severity: 'warn',
    sourceId: args.sourceId,
    subject: `e:${args.providerCode}`,
    key: `${args.providerCode}:${held}->${args.lastObsDate}`,
    details: { stored: held, published: args.lastObsDate, reason: 'latest observation went backwards' },
  });
}

// ── IMF ─────────────────────────────────────────────────────────────────────────────────────

async function runImfHalf(
  ctx: MarketJobContext,
  options: WorldMacroOptions,
  result: WorldMacroResult,
): Promise<void> {
  const explicit = options.imf;
  if (explicit !== undefined && (explicit === null || explicit.length === 0)) return;

  const seeded = await seededTargets(ctx.tx, IMF_SOURCE_ID);
  const targets: ImfTarget[] =
    explicit !== undefined
      ? [...explicit]
      : seeded.length > 0
        ? seeded.map((s) => ({
            indicator: s.indicator,
            area: IMF_DEFAULT_AREA.area,
            country: s.country,
          }))
        : IMF_WEO_HEADLINE_INDICATORS.map((indicator) => ({ indicator, ...IMF_DEFAULT_AREA }));
  if (targets.length === 0) return;

  const lines = linesOf(await resolveTargets(ctx, IMF_SOURCE_ID, { instrumentIds: null }));

  // ── the catalogue → `econ_series` ────────────────────────────────────────────────────────
  let catalogue: ImfRows | null = null;
  try {
    const raw = await fetchGet(ctx, IMF_SOURCE_ID, IMF_INDICATORS_URL, () =>
      fetchImf(ctx.http!, { kind: 'catalogue', ...requestEnvelope(ctx) }),
    );
    result.imf.requests += 1;
    if (raw.status !== 304) {
      result.fetched += 1;
      const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
        raw,
        adapterVersion: IMF_ADAPTER_VERSION,
        lines,
        normalise: (r, nctx) => normaliseImf(r, nctx),
      });
      result.provenanceIds.push(provenanceId);
      result.problems.push(...norm.problems);
      catalogue = norm.rows;
    }
  } catch (err) {
    result.errors.push(fetchError(err, IMF_INDICATORS_URL));
    return;
  }

  const seriesIds = new Map<string, number>();
  if (catalogue !== null && catalogue.kind === 'catalogue') {
    const wanted = new Set(targets.map((t) => t.indicator));
    for (const indicator of catalogue.indicators) {
      if (!wanted.has(indicator.providerCode)) continue;
      const target = targets.find((t) => t.indicator === indicator.providerCode)!;
      const release = await upsertEconRelease(ctx.tx, {
        sourceId: IMF_SOURCE_ID,
        providerReleaseId: indicator.dataset ?? 'WEO',
        name: IMF_WEO_RELEASE_NAME,
        country: target.country,
        url: null,
      });
      const seriesId = await ensureEconSeries(ctx.tx, {
        seriesCode: indicator.providerCode,
        sourceId: IMF_SOURCE_ID,
        providerCode: indicator.providerCode,
        name: indicator.name,
        // §10.8: `unit` is the vintage-bearing label; `source` names the WEO edition.
        units: indicator.units ?? indicator.source ?? indicator.name,
        frequency: 'A',
        seasonalAdj: null,
        country: target.country,
        decimals: 2,
      });
      await linkEconSeriesRelease(ctx.tx, seriesId, release.releaseId);
      seriesIds.set(indicator.providerCode, seriesId);
      result.imf.series += 1;
    }
  }

  // ── the observations → `econ_observations`, when a capture exists at all (§16.9) ─────────
  for (const target of targets) {
    const seriesId = seriesIds.get(target.indicator);
    if (seriesId === undefined) continue;
    const url = imfUrl({ kind: 'values', indicator: target.indicator, area: target.area });
    if (!canFetch(ctx, IMF_SOURCE_ID, url)) {
      result.imf.noCapture.push(url);
      ctx.log?.info?.('worldMacro.imf_no_capture', { url });
      continue;
    }

    let raw: RawRecord;
    try {
      raw = await fetchGet(ctx, IMF_SOURCE_ID, url, () =>
        fetchImf(ctx.http!, {
          kind: 'values',
          indicator: target.indicator,
          area: target.area,
          ...requestEnvelope(ctx),
        }),
      );
    } catch (err) {
      result.errors.push(fetchError(err, url));
      continue;
    }
    result.imf.requests += 1;
    if (raw.status === 304) {
      result.skipped += 1;
      continue;
    }
    result.fetched += 1;

    const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
      raw,
      adapterVersion: IMF_ADAPTER_VERSION,
      lines,
      normalise: (r, nctx) => normaliseImf(r, nctx),
    });
    result.provenanceIds.push(provenanceId);
    result.problems.push(...norm.problems);
    result.published += publish(ctx, norm.updates, result.errors);

    const mine = norm.rows.observations.filter(
      (o) => o.providerCode === target.indicator && o.area === target.area,
    );
    const counts = await upsertEconObservations(ctx.tx, seriesId, mine.map(econObsFromImf), {
      provenanceId,
      capturedAt: raw.capturedAt,
    });
    foldCounts(result.imf, result, counts);

    const dates = mine.map((o) => o.obsDate).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (first !== undefined && last !== undefined) {
      await recordSeriesFacts(ctx.tx, seriesId, {
        firstObsDate: first,
        lastObsDate: last,
        capturedAt: raw.capturedAt,
      });
    }
  }
}

export function econObsFromImf(obs: ImfObservationRow): ObservationInput {
  return { obsDate: obs.obsDate, value: obs.value, status: obs.status };
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'worldMacro',
  schedule: WORLD_MACRO_SCHEDULE,
  provider: [WORLDBANK_SOURCE_ID, IMF_SOURCE_ID] as readonly ProviderId[],
  priority: 3 as const,
  timeoutMs: 600_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runWorldMacro(ctx),
};
