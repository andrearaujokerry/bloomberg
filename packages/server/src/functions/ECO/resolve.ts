/**
 * `functions/ECO/resolve.ts` — the economic calendar (FUNCTIONS_TIER2.md §ECO L1156-1320).
 *
 * Two modes off one resolver: the week grid (`mode:'calendar'`) and one release's history with
 * every observation vintage behind it (`mode:'release'`, `REL=<id>`).
 *
 * The column this screen is defined by is the one it refuses to fill. There is no consensus
 * provider in the reachable set (BRIEF §2), so `consensus` is `{ v: null, r: 'NO_CONSENSUS_SOURCE' }`
 * on **every** row, `surprisePct` is `null` on every row, and both facts are stated once per run in
 * `meta.unavailable` rather than discovered per cell. A blank consensus column would read as "no
 * surprise"; a zero would read as "the forecast was met". The database agrees with the payload:
 * `econ_release_events.consensus` is `NULL` by schema and `consensus_unavailable_reason` carries
 * the same code, so there is no path by which a number could arrive here.
 *
 * The other thing this screen exists for is **vintages**. `prior` and `revisedPrior` come out of
 * the stored `econ_release_events` row as the publisher printed them, and release mode lists every
 * `econ_observations` vintage of the last eight periods — a revision is data on screen, not a
 * footnote (STOR-06). Everything is read at `ctx.asOf.knownAt`, so an export re-supplying the
 * as-of reproduces the same vintages.
 *
 * §0.4 rule 2 applies: this is a monitor, so it never calls `ctx.providers.ensure` for a quote.
 * Release mode's `fred.series` read-through is a *series* refresh, not a quote, and is best-effort.
 */

import { sql } from 'drizzle-orm';

import type { ValueCell, ValueState } from '@terminal/core';
import { datesInRange, type IsoDate } from '@terminal/core/calendars/calendar';
import type {
  EcoDay,
  EcoEventRow,
  EcoFomcRow,
  EcoImportance,
  EcoObservation,
  EcoParams,
  EcoPayload,
  EcoRange,
  EcoReleaseBlock,
  EcoSeriesBlock,
  EcoSourceId,
  EcoVintageGroup,
} from '@terminal/core/functions/manifests/ECO';
import {
  ECO_CONSENSUS,
  ECO_CONSENSUS_DETAIL,
  ECO_SURPRISE_DETAIL,
  ecoShift,
  ecoWindow,
  NO_CONSENSUS_SOURCE,
} from '@terminal/core/functions/manifests/ECO';
import { localClock } from '@terminal/core/quote/session';

import type { EconEvent, EconObs, EconSeries } from '../../data/econ.js';
import type { ResolveContext } from '../context.js';
import { cellFromState } from '../shared/cells.js';

const CALENDAR_STALE = 'CALENDAR_STALE';
const CALENDAR_STALE_MS = 36 * 3_600_000;
/** §ECO step 4: events near the open of the wire get a live subject. */
const LIVE_WINDOW_BACK_MS = 2 * 3_600_000;
const LIVE_WINDOW_FORWARD_MS = 12 * 3_600_000;
const RELEASE_EVENT_LIMIT = 12;
const REVISION_PERIODS = 8;
const OBSERVATION_YEARS = 5;


// ─────────────────────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ProvRow extends Record<string, unknown> {
  provenance_id: string;
  source_id: string;
  captured_at: string;
  source_ts: string | null;
}

/**
 * Register a set of `provenance` rows and return `{ idx, sourceId, capturedAtMs }` per id.
 *
 * `EconEvent` and `EconObs` carry a `provenanceId` but not the capture instant, and `ctx.prov.add`
 * needs one: the collector's job is to let a user press Ctrl+I on a cell and see when the value was
 * fetched. One statement for the whole screen keeps §ECO's two-round-trip budget.
 */
interface CiteEntry {
  idx: number;
  sourceId: string;
  capturedAtMs: number;
}
type CiteMap = Map<number, CiteEntry>;

async function citeAll(
  ctx: ResolveContext,
  ids: readonly number[],
  st: ValueState,
): Promise<CiteMap> {
  const out: CiteMap = new Map();
  const want = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (want.length === 0) return out;
  const list = sql.join(
    want.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<ProvRow>(sql`
    SELECT provenance_id::text AS provenance_id, source_id,
           to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           to_char(source_ts   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts
      FROM provenance
     WHERE provenance_id IN (${list})`);
  for (const row of res.rows) {
    const id = Number(row.provenance_id);
    const capturedAt = new Date(row.captured_at);
    out.set(id, {
      idx: ctx.prov.add({
        sourceId: row.source_id,
        provenanceId: id,
        capturedAt,
        sourceTs: row.source_ts === null ? null : new Date(row.source_ts),
        st,
        tier: 'eod',
      }),
      sourceId: row.source_id,
      capturedAtMs: capturedAt.getTime(),
    });
  }
  return out;
}

/** The newest capture instant among a set of provenance rows, for the staleness test. */
async function newestCapture(ctx: ResolveContext, ids: readonly number[]): Promise<number | null> {
  const want = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (want.length === 0) return null;
  const list = sql.join(
    want.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<{ newest: string | null }>(sql`
    SELECT to_char(max(captured_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS newest
      FROM provenance
     WHERE provenance_id IN (${list})`);
  const newest = res.rows[0]?.newest ?? null;
  return newest === null ? null : Date.parse(newest);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Releases
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ReleaseRow extends Record<string, unknown> {
  release_id: string;
  source_id: string;
  name: string;
  country: string;
  url: string | null;
  importance: number;
}

const ECO_SOURCES: readonly EcoSourceId[] = ['fred.calendar', 'bls.schedule', 'fed.fomc'];

const sourceIdOf = (value: string | undefined): EcoSourceId =>
  ECO_SOURCES.find((s) => s === value) ?? 'fred.calendar';

const importanceOf = (value: number): EcoImportance =>
  value <= 1 ? 1 : value >= 3 ? 3 : 2;

async function releasesByIds(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, ReleaseRow>> {
  const out = new Map<number, ReleaseRow>();
  const want = [...new Set(ids)];
  if (want.length === 0) return out;
  const list = sql.join(
    want.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<ReleaseRow>(sql`
    SELECT release_id::text AS release_id, source_id, name, country, url, importance
      FROM econ_releases
     WHERE release_id IN (${list})`);
  for (const row of res.rows) out.set(Number(row.release_id), row);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RowContext {
  releases: Map<number, ReleaseRow>;
  series: Map<string, EconSeries>;
  prov: Map<number, { idx: number; sourceId: string; capturedAtMs: number }>;
  stale: boolean;
}

/**
 * One `EcoEventRow`.
 *
 * `actual` is `blank` while the print is still scheduled — nothing is wrong, the number has simply
 * not been published — and `na` when a released event has no headline value, which happens when
 * the release has no series in `econ_series` and the publisher prints prose. `revisedPrior` is
 * `na` when the period was never revised: an unrevised print has no revised prior, which is not a
 * denial and carries no reason code.
 */
function eventRow(ctx: ResolveContext, e: EconEvent, rc: RowContext): EcoEventRow {
  const release = rc.releases.get(e.releaseId);
  const prov = rc.prov.get(e.provenanceId);
  const provIdx = prov?.idx ?? -1;
  const st: ValueState = rc.stale ? 'stale' : 'closed';
  const ts = Date.parse(e.scheduledAt);
  const series = e.seriesCode === null ? undefined : rc.series.get(e.seriesCode);

  const stored = (v: number | null, whenNull: ValueState): ValueCell =>
    v === null ? { v: null, st: whenNull, provIdx } : { v, st, ts, provIdx };

  if (e.actual === null && e.status !== 'scheduled' && e.seriesId === null) {
    ctx.unavailable.add({
      field: 'ECO_VALUE',
      reason: 'NOT_APPLICABLE',
      detail:
        'release has no headline series in econ_series; actual is published as text only',
    });
  }

  return {
    eventId: e.eventId,
    releaseId: e.releaseId,
    releaseName: e.releaseName,
    sourceId: sourceIdOf(release?.source_id ?? prov?.sourceId),
    country: e.country,
    url: e.url,
    importance: importanceOf(e.importance),
    scheduledAt: e.scheduledAt,
    timeKnown: e.timeKnown,
    periodLabel: e.periodLabel,
    seriesCode: e.seriesCode,
    seriesName: series?.name ?? null,
    units: series?.units ?? null,
    decimals: series?.decimals ?? null,
    actual: stored(e.actual, e.status === 'scheduled' ? 'blank' : 'na'),
    prior: stored(e.prior, 'na'),
    revisedPrior: stored(e.revisedPrior, 'na'),
    consensus: ECO_CONSENSUS,
    surprisePct: null,
    status: e.status,
    subject: e.seriesCode === null ? null : `e:${e.seriesCode}`,
    provIdx,
  };
}

/**
 * §ECO step 4 — a print that lands while the screen is open flashes in place.
 *
 * Only events inside `[now − 2 h, now + 12 h]` get a plant subscription, and the resolver reads the
 * plant rather than a provider (§0.4 rule 2). A subject the plant does not hold leaves the stored
 * cell exactly as it was: `cellFromState` would return a *pending* cell, which is the right answer
 * for a quote that was never polled and the wrong one for a value that is already published and
 * sitting in `econ_release_events`.
 */
function applyLiveActuals(ctx: ResolveContext, rows: EcoEventRow[], nowMs: number): void {
  const live = rows.filter((r) => {
    if (r.subject === null) return false;
    const at = Date.parse(r.scheduledAt);
    return (
      Number.isFinite(at) && at >= nowMs - LIVE_WINDOW_BACK_MS && at <= nowMs + LIVE_WINDOW_FORWARD_MS
    );
  });
  if (live.length === 0) return;
  const subjects = [...new Set(live.map((r) => r.subject!))];
  ctx.plant.ensureHot(subjects);
  const states = ctx.plant.snapshotMany(subjects);
  for (const row of live) {
    const subject = row.subject!;
    const state = states.get(subject);
    if (state === undefined) continue;
    row.actual = cellFromState(ctx, state, 'ECO_VALUE', subject);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cursor (§ECO step 7)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface EcoCursor {
  anchor: string;
  range: EcoRange;
}

export function encodeEcoCursor(cursor: EcoCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeEcoCursor(cursor: string | null | undefined): EcoCursor | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { anchor, range } = parsed as { anchor?: unknown; range?: unknown };
    if (typeof anchor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return null;
    if (range !== 'D' && range !== 'W' && range !== 'M') return null;
    return { anchor, range };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Release mode (§ECO step 8)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ReleaseEventRow extends Record<string, unknown> {
  event_id: string;
  release_id: string;
  scheduled_at: string;
  time_known: boolean;
  period_label: string;
  series_id: string | null;
  series_code: string | null;
  actual: string | null;
  prior: string | null;
  revised_prior: string | null;
  status: string;
  provenance_id: string;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

async function releaseEvents(
  ctx: ResolveContext,
  releaseId: number,
  limit: number,
): Promise<ReleaseEventRow[]> {
  const res = await ctx.db.execute<ReleaseEventRow>(sql`
    SELECT e.event_id::text AS event_id, e.release_id::text AS release_id,
           to_char(e.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scheduled_at,
           e.time_known, e.period_label, e.series_id::text AS series_id, s.series_code,
           e.actual::text AS actual, e.prior::text AS prior, e.revised_prior::text AS revised_prior,
           e.status, e.provenance_id::text AS provenance_id
      FROM econ_release_events e
      LEFT JOIN econ_series s ON s.series_id = e.series_id
     WHERE e.release_id = ${String(releaseId)}::bigint
     ORDER BY e.scheduled_at DESC
     LIMIT ${limit}`);
  return [...res.rows];
}

async function seriesOfRelease(ctx: ResolveContext, releaseId: number): Promise<string[]> {
  const res = await ctx.db.execute<{ series_code: string }>(sql`
    SELECT series_code FROM econ_series
     WHERE release_id = ${String(releaseId)}::bigint
     ORDER BY series_code`);
  return res.rows.map((r) => r.series_code);
}

/** Every stored vintage of the last `REVISION_PERIODS` observation dates (STOR-06's audit view). */
async function vintagesOf(
  ctx: ResolveContext,
  seriesCode: string,
  obsDates: readonly string[],
): Promise<EcoVintageGroup[]> {
  if (obsDates.length === 0) return [];
  const list = sql.join(
    obsDates.map((d) => sql`${d}::date`),
    sql`, `,
  );
  const res = await ctx.db.execute<{
    obs_date: string;
    vintage_at: string;
    value: string | null;
    status: string;
  }>(sql`
    SELECT o.obs_date::text AS obs_date,
           to_char(o.vintage_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS vintage_at,
           o.value::text AS value, o.status
      FROM econ_observations o
      JOIN econ_series s ON s.series_id = o.series_id
     WHERE s.series_code = ${seriesCode}
       AND o.obs_date IN (${list})
       AND o.vintage_at <= ${ctx.asOf.knownAt}::timestamptz
     ORDER BY o.obs_date DESC, o.vintage_at ASC`);
  const groups = new Map<string, EcoVintageGroup>();
  for (const row of res.rows) {
    let group = groups.get(row.obs_date);
    if (group === undefined) {
      group = { obsDate: row.obs_date, vintages: [] };
      groups.set(row.obs_date, group);
    }
    group.vintages.push({
      vintageAt: row.vintage_at,
      value: num(row.value),
      status: row.status,
    });
  }
  return [...groups.values()];
}

async function buildRelease(
  ctx: ResolveContext,
  releaseId: number,
  window: { from: string; to: string },
  rc: Omit<RowContext, 'releases'> & { releases: Map<number, ReleaseRow> },
): Promise<EcoReleaseBlock | null> {
  const release = rc.releases.get(releaseId);
  if (release === undefined) return null;

  const rawEvents = await releaseEvents(ctx, releaseId, RELEASE_EVENT_LIMIT);
  const eventProv = await citeAll(
    ctx,
    rawEvents.map((r) => Number(r.provenance_id)),
    'closed',
  );
  const codes = [
    ...new Set(rawEvents.map((r) => r.series_code).filter((c): c is string => c !== null)),
  ];
  const seriesCodes = [...new Set([...codes, ...(await seriesOfRelease(ctx, releaseId))])];
  const seriesDefs = await ctx.data.econ.seriesByCodes(seriesCodes);

  const events = rawEvents.map((row) =>
    eventRow(
      ctx,
      {
        eventId: Number(row.event_id),
        releaseId,
        releaseName: release.name,
        country: release.country,
        importance: release.importance,
        url: release.url,
        scheduledAt: row.scheduled_at,
        timeKnown: row.time_known,
        periodLabel: row.period_label,
        seriesId: row.series_id === null ? null : Number(row.series_id),
        seriesCode: row.series_code,
        actual: num(row.actual),
        prior: num(row.prior),
        revisedPrior: num(row.revised_prior),
        consensus: null,
        consensusUnavailableReason: NO_CONSENSUS_SOURCE,
        status: row.status as EconEvent['status'],
        provenanceId: Number(row.provenance_id),
      },
      { ...rc, series: seriesDefs, prov: eventProv },
    ),
  );

  const from = shiftYears(window.from, -OBSERVATION_YEARS);
  const series: EcoSeriesBlock[] = [];
  for (const code of seriesCodes) {
    const def = seriesDefs.get(code);
    if (def === undefined) continue;
    if (ctx.usage !== 'export' && isStaleSeries(def, ctx.clock.now())) {
      try {
        await ctx.providers.ensure('fred.series', code, { maxAgeMs: 3_600_000 });
      } catch {
        // A refused refresh leaves the stored observations on screen (TERM-12), never a 503.
      }
    }
    const observations = await ctx.data.econ.observations(code, {
      from,
      to: window.to,
      knownAt: ctx.asOf.knownAt,
    });
    const obsProv = await citeAll(
      ctx,
      observations.map((o) => o.provenanceId),
      'closed',
    );
    const rows: EcoObservation[] = observations.map((o: EconObs) => ({
      obsDate: o.obsDate,
      value: o.value,
      status: o.status,
      vintageAt: o.vintageAt,
      isLatest: o.isLatest,
      footnote: o.footnote,
      provIdx: obsProv.get(o.provenanceId)?.idx ?? -1,
    }));
    const recent = rows.slice(-REVISION_PERIODS).map((r) => r.obsDate);
    series.push({
      seriesCode: code,
      name: def.name,
      units: def.units,
      frequency: def.frequency,
      seasonalAdj: def.seasonalAdj,
      decimals: def.decimals,
      lastObsDate: def.lastObsDate,
      lastUpdatedAt: def.lastUpdatedAt,
      observations: rows,
      revisions: await vintagesOf(ctx, code, recent),
      chart: rows.map((r) => ({ t: Date.parse(`${r.obsDate}T00:00:00.000Z`), v: r.value })),
    });
  }

  const nextRaw = await ctx.data.econ.nextRelease(releaseId, ctx.asOf.validAt);
  const nextProv: CiteMap =
    nextRaw === null ? new Map<number, CiteEntry>() : await citeAll(ctx, [nextRaw.provenanceId], 'closed');

  return {
    releaseId,
    name: release.name,
    sourceId: sourceIdOf(release.source_id),
    country: release.country,
    url: release.url,
    importance: importanceOf(release.importance),
    events,
    series,
    nextEvent:
      nextRaw === null
        ? null
        : eventRow(ctx, nextRaw, { ...rc, series: seriesDefs, prov: nextProv }),
  };
}

function isStaleSeries(def: EconSeries, nowMs: number): boolean {
  if (def.lastUpdatedAt === null) return true;
  const at = Date.parse(def.lastUpdatedAt);
  return !Number.isFinite(at) || nowMs - at > 3_600_000;
}

function shiftYears(date: string, years: number): string {
  const year = Number(date.slice(0, 4)) + years;
  return `${String(year).padStart(4, '0')}${date.slice(4)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolve
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: EcoParams): Promise<EcoPayload> {
  // ── step 1: the window ────────────────────────────────────────────────────────────────────
  const today: IsoDate =
    localClock('America/New_York', ctx.asOf.validAt.getTime())?.date ??
    ctx.asOf.validAt.toISOString().slice(0, 10);
  // The runner hands a page turn the cursor out of the CACHED meta plus a direction, and there is
  // only one cursor to cache (`runner.ts#page`). A window pager therefore caches the anchor it is
  // rendering and shifts it by the direction asked for, rather than caching "the next window" —
  // which would page forward correctly and page back into the window after this one.
  const paged = decodeEcoCursor(ctx.page?.cursor);
  const range: EcoRange = paged?.range ?? params.range;
  const anchor: IsoDate =
    paged === null
      ? (params.date ?? today)
      : ecoShift(paged.anchor, range, ctx.page?.direction === 'back' ? -1 : 1);
  const window = ecoWindow(anchor, range);
  const notes: string[] = [];

  // ── step 2: the events ────────────────────────────────────────────────────────────────────
  // `params.importance` is §ECO's "minimum `econ_releases.importance` shown (1 = show everything)",
  // and the screen badges it `IMP ≥ <n>` — so the predicate is `importance >= params.importance`.
  // `EconCalendarQuery.minImportance` is NOT that: WP-04 defines it as `importance <= n` ("at least
  // this important", on the schema's scale where 1 is market-moving), which would make the DEFAULT
  // of 1 show only the most important releases rather than everything. Passing it would silently
  // empty the default screen, so the floor is applied here instead of in the query. The two
  // readings differ only above the default; if the product decides `I` should narrow toward the
  // market-moving end, this is the single line that changes.
  const unfiltered = await ctx.data.econ.calendar({
    from: window.from,
    to: window.to,
    country: params.country,
  });
  const rawEvents = unfiltered.filter((e) => e.importance >= params.importance);
  const eventProvIds = rawEvents.map((e) => e.provenanceId);
  const newest = await newestCapture(ctx, eventProvIds);
  const calendarStale = newest !== null && ctx.clock.now() - newest > CALENDAR_STALE_MS;
  if (calendarStale) notes.push(CALENDAR_STALE);

  const prov = await citeAll(ctx, eventProvIds, calendarStale ? 'stale' : 'closed');
  const releases = await releasesByIds(
    ctx,
    rawEvents.map((e) => e.releaseId),
  );
  const seriesCodes = [
    ...new Set(rawEvents.map((e) => e.seriesCode).filter((c): c is string => c !== null)),
  ];
  const seriesDefs = await ctx.data.econ.seriesByCodes(seriesCodes);
  const rc: RowContext = { releases, series: seriesDefs, prov, stale: calendarStale };

  // ── step 3: the rows ──────────────────────────────────────────────────────────────────────
  const rows = rawEvents.map((e) => eventRow(ctx, e, rc));
  ctx.unavailable.add({
    field: 'consensus',
    reason: 'NO_SOURCE',
    detail: ECO_CONSENSUS_DETAIL,
  });
  ctx.unavailable.add({
    field: 'surprisePct',
    reason: 'NO_SOURCE',
    detail: ECO_SURPRISE_DETAIL,
  });

  // ── step 4: the live overwrite ────────────────────────────────────────────────────────────
  applyLiveActuals(ctx, rows, ctx.clock.now());

  // ── step 5: the day grid ──────────────────────────────────────────────────────────────────
  let calendar: { isBusinessDay(d: IsoDate): boolean } | null = null;
  try {
    calendar = await ctx.data.reference.calendar('USGOVT');
  } catch {
    calendar = null;
  }
  const byDate = new Map<string, EcoEventRow[]>();
  for (const row of rows) {
    const day = nyDay(row.scheduledAt);
    const list = byDate.get(day);
    if (list === undefined) byDate.set(day, [row]);
    else list.push(row);
  }
  const days: EcoDay[] = datesInRange(window.from, window.to).map((date) => {
    const events = [...(byDate.get(date) ?? [])].sort(
      (a, b) =>
        a.scheduledAt.localeCompare(b.scheduledAt) || a.releaseName.localeCompare(b.releaseName),
    );
    return {
      date,
      isBusinessDay: calendar?.isBusinessDay(date) ?? false,
      events,
    };
  });

  // ── step 6: FOMC ──────────────────────────────────────────────────────────────────────────
  const fomc: EcoFomcRow[] = [];
  if (params.fomc) {
    const meetings = await ctx.data.econ.fomc();
    const upcoming = meetings.filter((m) => m.meetingDate >= today);
    const nextDate = upcoming[0]?.meetingDate ?? null;
    const keep = meetings.filter(
      (m) =>
        (m.meetingDate >= window.from && m.meetingDate <= window.to) ||
        upcoming.slice(0, 2).some((u) => u.meetingDate === m.meetingDate),
    );
    const fomcProv = await citeAll(
      ctx,
      keep.map((m) => m.provenanceId).filter((id): id is number => id !== null),
      'closed',
    );
    for (const m of keep) {
      fomc.push({
        meetingDate: m.meetingDate,
        statementAt: m.statementAt,
        hasSep: m.hasSep,
        decisionBp: m.decisionBp,
        isNext: m.meetingDate === nextDate,
        inWindow: m.meetingDate >= window.from && m.meetingDate <= window.to,
        provIdx: m.provenanceId === null ? -1 : (fomcProv.get(m.provenanceId)?.idx ?? -1),
      });
    }
  }

  // ── step 8: release mode ──────────────────────────────────────────────────────────────────
  let release: EcoReleaseBlock | null = null;
  if (params.releaseId !== undefined) {
    const own = await releasesByIds(ctx, [params.releaseId]);
    release = await buildRelease(ctx, params.releaseId, window, { ...rc, releases: own });
    if (release === null) {
      ctx.unavailable.add({
        field: 'release',
        reason: 'NO_SOURCE',
        detail: 'unknown release id',
      });
    }
  }

  // ── step 7: the cursor ────────────────────────────────────────────────────────────────────
  // `payload.cursor` is what the screen labels its arrows with: the anchors of the later and the
  // earlier window. `meta.page.cursor` is this window's own anchor — see step 1.
  const next = encodeEcoCursor({ anchor: ecoShift(anchor, range, 1), range });
  const prev = encodeEcoCursor({ anchor: ecoShift(anchor, range, -1), range });
  ctx.page?.set({
    index: 0,
    count: 1,
    cursor: encodeEcoCursor({ anchor: window.from, range }),
  });

  return {
    variant: 'default',
    mode: params.releaseId === undefined ? 'calendar' : 'release',
    window,
    country: params.country,
    importance: importanceOf(params.importance),
    days,
    fomc,
    release,
    consensus: { value: null, reason: NO_CONSENSUS_SOURCE },
    knownAt: ctx.asOf.knownAt.toISOString(),
    cursor: { prev, next },
    notes,
  };
}

/** The New York calendar day an instant falls on — the day the grid groups it under. */
function nyDay(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  return localClock('America/New_York', ms)?.date ?? iso.slice(0, 10);
}
