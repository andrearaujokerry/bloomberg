/**
 * `functions/GC/resolve.ts` — Benchmark Curve Chart (FUNCTIONS_TIER3.md §GC L1563-1734).
 *
 * Two modes over the same stored rows. `mode:'curve'` is a *comparison*: the served curve date and
 * up to four earlier ones, the basis-point change at every tenor, and the slope spreads. The
 * arithmetic is subtraction and nothing else — GC never bootstraps, never interpolates and never
 * carries a value forward, because every one of those would put a number on the screen that no
 * source published (FUNCTIONS.md §1.3 rule 6).
 *
 * Four decisions:
 *
 *  1. **A comparison is resolved against the dates that exist.** `PREV`, `1W`, `1M`, `3M`, `YTD`
 *     and `1Y` are resolved over `curve.availableDates` — the latest stored date at or before the
 *     target. An entry that resolves to nothing, or to a date already drawn, is dropped with a
 *     `NO_SOURCE` note and raises `CURVE_DATES_ONLY`; the offline build stores a handful of dates
 *     and saying so is the honest answer, not silently drawing three copies of the same curve.
 *  2. **A missing tenor is `na`, never zero.** An H.15 `ND` day or an unauctioned bill tenor is
 *     simply absent from that snapshot; its change cell is `{v:null, st:'na'}` and the spread that
 *     needed it is `na` with the leg named in `meta.unavailable`.
 *  3. **GC never triggers a bootstrap.** `buildId` is read straight out of `curve_builds`; a miss
 *     leaves it `null` and the snapshot is still drawn from the published points. Bootstrapping a
 *     comparison date here would make a *chart* write to the database.
 *  4. **History is stored history.** A tenor with a mapped `econ_series` reads vintaged
 *     observations at `knownAt`; the SOFR overnight leg reads `rate_fixings`; everything else
 *     reads the `curve_points` of the stored curve dates. A series shorter than the range is
 *     `truncated` with the first stored date named, and a tenor with no series at all comes back
 *     with `obs: []` and the reason — the chart draws nothing for it and the legend says why.
 */

import { sql } from 'drizzle-orm';

import type { ValueCell, ValueState } from '@terminal/core';
import {
  addDays,
  addMonths,
  addYears,
  businessDaysBetween,
  type IsoDate,
} from '@terminal/core/calendars/calendar';
import type {
  GcCaveat,
  GcChange,
  GcCurveId,
  GcHistory,
  GcHistorySeries,
  GcObservation,
  GcParams,
  GcPayload,
  GcSnapshot,
  GcSnapshotPoint,
  GcSpreadId,
  GcSpreadRow,
  GcSpreadSeries,
  GcTenor,
  GcVsEntry,
} from '@terminal/core/functions/manifests/GC';
import {
  GC_FIXING_MAP,
  GC_SERIES_MAP,
  GC_SPREAD_LEGS,
} from '@terminal/core/functions/manifests/GC';

import type { CurvePoints } from '../../data/curves.js';
import { AppError } from '../../http/errors.js';
import type { ResolveContext } from '../context.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const naCell = (): ValueCell => ({ v: null, st: 'na', provIdx: -1 });

const cell = (v: number, provIdx: number, st: ValueState, ts: number | null): ValueCell => ({
  v,
  st,
  provIdx,
  ts,
});

/** A curve older than this many SIFMA business days is stale (TERM-12). */
const STALE_BUSINESS_DAYS = 5;

type ProvRow = {
  provenance_id: string;
  source_id: string;
  captured_at: string;
  source_ts: string | null;
};

async function citeMany(
  ctx: ResolveContext,
  ids: readonly number[],
  st: ValueState,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const want: number[] = [];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || want.includes(id)) continue;
    want.push(id);
  }
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
  const rows = new Map(res.rows.map((row) => [Number(row.provenance_id), row]));
  for (const id of want) {
    const row = rows.get(id);
    if (row === undefined) continue;
    out.set(
      id,
      ctx.prov.add({
        sourceId: row.source_id,
        provenanceId: id,
        capturedAt: new Date(row.captured_at),
        sourceTs: row.source_ts === null ? null : new Date(row.source_ts),
        st,
        tier: 'eod',
      }),
    );
  }
  return out;
}

function nyDate(at: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** `'2026-09-14'` → `'09-14'`, the chart legend's label. */
function labelOf(date: string): string {
  return date.slice(5);
}

/** The latest stored date at or before `target`, or `null`. */
function latestOnOrBefore(dates: readonly string[], target: string): string | null {
  let best: string | null = null;
  for (const date of dates) {
    if (date <= target && (best === null || date > best)) best = date;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Comparison resolution (§GC resolver step 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The target date a comparison entry asks for, relative to the served curve date. */
function compareTarget(entry: string, curveDate: IsoDate): string | null {
  switch (entry) {
    case 'PREV':
      return addDays(curveDate, -1);
    case '1W':
      return addDays(curveDate, -7);
    case '1M':
      return addMonths(curveDate, -1);
    case '3M':
      return addMonths(curveDate, -3);
    case '1Y':
      return addYears(curveDate, -1);
    case 'YTD':
      return `${String(Number(curveDate.slice(0, 4)) - 1)}-12-31`;
    default:
      return /^\d{4}-\d{2}-\d{2}$/.test(entry) ? entry : null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const code = 'GC';

export async function resolve(ctx: ResolveContext, params: GcParams): Promise<GcPayload> {
  const valuationDate = nyDate(ctx.asOf.validAt);
  const wanted = params.date ?? valuationDate;

  const points = await ctx.data.curves.points(params.curveId, wanted).catch(() => null);
  if (points === null || points.points.length === 0) {
    throw new AppError('VALIDATION_FAILED', `no ${params.curveId} curve on or before ${wanted}.`, {
      details: { location: 'fnParams', field: 'date' },
    });
  }

  // ── staleness (TERM-12) ────────────────────────────────────────────────────────────────────
  const calendar = await ctx.data.reference.calendar('SIFMA').catch(() => null);
  const behind =
    calendar === null
      ? 0
      : businessDaysBetween(calendar, points.curveDate, valuationDate);
  const state: ValueState = behind > STALE_BUSINESS_DAYS ? 'stale' : 'closed';

  const caveats: GcCaveat[] = [];
  if (params.curveId === 'SOFR_OIS') caveats.push('PROXY_CURVE');

  // ── snapshots ──────────────────────────────────────────────────────────────────────────────
  const current = await snapshotOf(ctx, points, { id: 'CUR', requested: wanted }, state);
  const snapshots: GcSnapshot[] = [current];
  const used = new Set<string>([points.curveDate]);
  let dropped = false;

  if (params.mode === 'curve') {
    for (const entry of params.compare) {
      const target = compareTarget(entry, points.curveDate);
      const resolved: string | null =
        target === null ? null : latestOnOrBefore(points.availableDates, target);
      if (resolved === null || used.has(resolved)) {
        dropped = true;
        ctx.unavailable.add({
          field: `compare.${entry}`,
          reason: 'NO_SOURCE',
          detail:
            `no ${params.curveId} curve on or before ${target ?? entry}; earliest stored ` +
            `${points.availableDates[points.availableDates.length - 1] ?? 'none'}`,
        });
        continue;
      }
      used.add(resolved);
      const other = await ctx.data.curves.points(params.curveId, resolved).catch(() => null);
      if (other === null || other.points.length === 0) {
        dropped = true;
        ctx.unavailable.add({
          field: `compare.${entry}`,
          reason: 'NO_SOURCE',
          detail: `no ${params.curveId} curve on or before ${resolved}`,
        });
        continue;
      }
      snapshots.push(
        await snapshotOf(
          ctx,
          other,
          { id: /^\d{4}-\d{2}-\d{2}$/.test(entry) ? `D:${entry}` : entry, requested: entry },
          state,
        ),
      );
    }
  }
  if (dropped) caveats.push('CURVE_DATES_ONLY');

  // ── changes and spreads ────────────────────────────────────────────────────────────────────
  const comparisons = snapshots.slice(1);
  const changes: GcChange[] = current.points.map((point) => ({
    tenor: point.tenor,
    tenorDays: point.tenorDays,
    current: point.value,
    vs: comparisons.map((snapshot) => bpEntry(snapshot, point.tenor, point.value)),
  }));

  const spreads: GcSpreadRow[] = params.spreads.map((id) =>
    spreadRow(ctx, id, current, comparisons, params.curveId),
  );

  // ── history ────────────────────────────────────────────────────────────────────────────────
  const history =
    params.mode === 'history'
      ? await historyOf(ctx, params, points, state, caveats)
      : null;

  return {
    variant: 'default',
    mode: params.mode,
    curve: {
      id: params.curveId,
      name: points.name,
      currency: points.currency,
      kind: points.kind,
      dayCount: points.dayCount,
      compounding: points.compounding,
      sourceId: points.sourceId,
      provIdx: current.provIdx,
      date: points.curveDate,
      requestedDate: params.date,
      availableDates: points.availableDates,
    },
    snapshots,
    changes,
    spreads,
    history,
    caveats,
    asOf: ctx.asOf.validAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Snapshots
// ─────────────────────────────────────────────────────────────────────────────────────────────

type BuildRow = { build_id: string };

/** The `curve_builds.build_id` already stored for this date, or `null` — never a fresh bootstrap. */
async function existingBuildId(
  ctx: ResolveContext,
  curveId: string,
  curveDate: string,
): Promise<number | null> {
  const res = await ctx.db.execute<BuildRow>(sql`
    SELECT build_id::text AS build_id
      FROM curve_builds
     WHERE curve_id = ${curveId}
       AND curve_date = ${curveDate}::date
     ORDER BY build_id DESC
     LIMIT 1`);
  const row = res.rows[0];
  return row === undefined ? null : Number(row.build_id);
}

async function snapshotOf(
  ctx: ResolveContext,
  points: CurvePoints,
  ids: { id: string; requested: string },
  state: ValueState,
): Promise<GcSnapshot> {
  const cite = await citeMany(
    ctx,
    points.points.map((p) => p.provenanceId),
    state,
  );
  const first = points.points[0]!;
  const provIdx = cite.get(first.provenanceId) ?? -1;
  const seen = new Set<string>();
  const rows: GcSnapshotPoint[] = [];
  for (const point of points.points) {
    // A bill curve publishes a discount rate and an investment yield at the same tenor; the yield
    // is the comparable number, so the discount row is not drawn twice into the same series.
    if (point.quoteType === 'discount_rate' && points.kind === 'bill') continue;
    if (seen.has(point.tenor)) continue;
    seen.add(point.tenor);
    rows.push({
      tenor: point.tenor,
      tenorDays: point.tenorDays,
      quoteType: point.quoteType,
      value: cell(
        point.value,
        cite.get(point.provenanceId) ?? provIdx,
        state,
        point.sourceTs === null ? null : Date.parse(point.sourceTs),
      ),
    });
  }
  return {
    id: ids.id,
    label: labelOf(points.curveDate),
    requested: ids.requested,
    date: points.curveDate,
    buildId: await existingBuildId(ctx, points.curveId, points.curveDate),
    provIdx,
    points: rows.sort((a, b) => a.tenorDays - b.tenorDays),
  };
}

/** `(current − snapshot) × 100` in basis points, or `na` when the tenor is absent from it. */
function bpEntry(snapshot: GcSnapshot, tenor: string, current: ValueCell): GcVsEntry {
  const other = snapshot.points.find((p) => p.tenor === tenor);
  const a = typeof current.v === 'number' ? current.v : null;
  const b = other !== undefined && typeof other.value.v === 'number' ? other.value.v : null;
  return {
    id: snapshot.id,
    label: snapshot.label,
    date: snapshot.date,
    bp: a === null || b === null ? naCell() : cell((a - b) * 100, snapshot.provIdx, 'closed', null),
  };
}

/** The value of one tenor on a snapshot, or `null`. */
function tenorValue(snapshot: GcSnapshot, tenor: string): number | null {
  const point = snapshot.points.find((p) => p.tenor === tenor);
  return point !== undefined && typeof point.value.v === 'number' ? point.value.v : null;
}

function spreadRow(
  ctx: ResolveContext,
  id: GcSpreadId,
  current: GcSnapshot,
  comparisons: readonly GcSnapshot[],
  curveId: GcCurveId,
): GcSpreadRow {
  const [short, long] = GC_SPREAD_LEGS[id];
  const spreadOn = (snapshot: GcSnapshot): number | null => {
    const a = tenorValue(snapshot, long);
    const b = tenorValue(snapshot, short);
    return a === null || b === null ? null : (a - b) * 100;
  };
  const value = spreadOn(current);
  if (value === null) {
    const missing = tenorValue(current, long) === null ? long : short;
    ctx.unavailable.add({
      field: `spreads.${id}`,
      reason: 'NO_SOURCE',
      detail: `${missing} not on the ${curveId} curve for ${current.date}`,
    });
  }
  return {
    id,
    label: `${long} − ${short}`,
    legs: [short, long],
    current: value === null ? naCell() : cell(value, current.provIdx, 'closed', null),
    vs: comparisons.map((snapshot) => {
      const other = spreadOn(snapshot);
      return {
        id: snapshot.id,
        label: snapshot.label,
        date: snapshot.date,
        bp:
          value === null || other === null
            ? naCell()
            : cell(value - other, snapshot.provIdx, 'closed', null),
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// History (§GC resolver steps 6-7)
// ─────────────────────────────────────────────────────────────────────────────────────────────

type PointHistoryRow = {
  curve_date: string;
  value: string;
  provenance_id: string;
};

function rangeStart(to: IsoDate, range: GcParams['range']): IsoDate | null {
  switch (range) {
    case '1M':
      return addMonths(to, -1);
    case '3M':
      return addMonths(to, -3);
    case '6M':
      return addMonths(to, -6);
    case '1Y':
      return addYears(to, -1);
    case '5Y':
      return addYears(to, -5);
    case 'MAX':
      return null;
  }
}

async function historyOf(
  ctx: ResolveContext,
  params: GcParams,
  points: CurvePoints,
  state: ValueState,
  caveats: GcCaveat[],
): Promise<GcHistory> {
  const to = points.curveDate;
  const start = rangeStart(to, params.range);
  const from = start ?? '1900-01-01';
  const series: GcHistorySeries[] = [];
  let gaps = false;

  for (const tenor of params.tenors) {
    const built = await seriesFor(ctx, params, tenor, from, to, state);
    if (built.truncated || built.obs.length === 0) {
      gaps = true;
      ctx.unavailable.add({
        field: `history.${tenor}`,
        reason: 'NO_SOURCE',
        detail:
          built.coverage.first === null
            ? `no stored series for ${params.curveId} ${tenor}`
            : `${built.seriesCode ?? tenor} stored from ${built.coverage.first}; requested from ${from}`,
      });
    }
    series.push(built);
  }
  if (gaps) caveats.push('NO_LONG_HISTORY_FOR_TENOR');

  // Spread series are computed on the **date intersection** of their two legs: a date present in
  // only one leg is skipped, never filled (§1.3 rule 6).
  const spreadSeries: GcSpreadSeries[] = [];
  for (const id of params.spreads) {
    const [short, long] = GC_SPREAD_LEGS[id];
    const shortSeries = series.find((s) => s.tenor === short);
    const longSeries = series.find((s) => s.tenor === long);
    if (shortSeries === undefined || longSeries === undefined) continue;
    const shortBy = new Map(shortSeries.obs.map((o) => [o.d, o.v]));
    const obs: GcObservation[] = [];
    for (const point of longSeries.obs) {
      const other = shortBy.get(point.d);
      if (other === undefined || other === null || point.v === null) continue;
      obs.push({ d: point.d, v: (point.v - other) * 100 });
    }
    spreadSeries.push({ id, label: `${long} − ${short}`, legs: [short, long], unit: 'bp', obs });
  }

  const firsts = series.flatMap((s) => (s.coverage.first === null ? [] : [s.coverage.first]));
  return {
    range: params.range,
    from: start ?? (firsts.sort()[0] ?? to),
    to,
    series,
    spreadSeries,
  };
}

async function seriesFor(
  ctx: ResolveContext,
  params: GcParams,
  tenor: GcTenor,
  from: string,
  to: string,
  state: ValueState,
): Promise<GcHistorySeries> {
  const seriesCode = GC_SERIES_MAP[params.curveId]?.[tenor];
  if (seriesCode !== undefined) {
    const definition = await ctx.data.econ.series(seriesCode);
    if (definition !== null) {
      const observations = await ctx.data.econ.observations(seriesCode, {
        from,
        to,
        knownAt: ctx.asOf.knownAt,
      });
      const cite = await citeMany(
        ctx,
        observations.map((o) => o.provenanceId),
        state,
      );
      const obs: GcObservation[] = observations.map((o) => ({ d: o.obsDate, v: o.value }));
      const first = obs[0];
      const firstProv = observations[0];
      return {
        tenor,
        source: 'econ_series',
        seriesCode,
        sourceId: definition.sourceId,
        provIdx: firstProv === undefined ? -1 : (cite.get(firstProv.provenanceId) ?? -1),
        unit: 'pct',
        obs,
        coverage: {
          first: first?.d ?? null,
          last: obs[obs.length - 1]?.d ?? null,
          n: obs.length,
        },
        truncated: first !== undefined && first.d > from,
      };
    }
  }

  const fixingCode = GC_FIXING_MAP[params.curveId]?.[tenor];
  if (fixingCode !== undefined) {
    const fixings = await ctx.data.rates
      .history(fixingCode, 4000)
      .catch(() => [] as Awaited<ReturnType<typeof ctx.data.rates.history>>);
    const inRange = fixings
      .filter((f) => f.effectiveDate >= from && f.effectiveDate <= to)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    const cite = await citeMany(
      ctx,
      inRange.map((f) => f.provenanceId),
      state,
    );
    const obs: GcObservation[] = inRange.map((f) => ({ d: f.effectiveDate, v: f.rate }));
    const firstFixing = inRange[0];
    return {
      tenor,
      source: 'rate_fixings',
      seriesCode: fixingCode,
      sourceId: 'nyfed.rates',
      provIdx: firstFixing === undefined ? -1 : (cite.get(firstFixing.provenanceId) ?? -1),
      unit: 'pct',
      obs,
      coverage: {
        first: obs[0]?.d ?? null,
        last: obs[obs.length - 1]?.d ?? null,
        n: obs.length,
      },
      truncated: obs.length > 0 && (obs[0]?.d ?? '') > from,
    };
  }

  // Fallback: the tenor's own `curve_points` across the stored curve dates. One query, vintaged at
  // `knownAt`, and nothing between two stored dates is invented.
  const res = await ctx.db.execute<PointHistoryRow>(sql`
    SELECT DISTINCT ON (curve_date)
           curve_date::text AS curve_date, value::text AS value,
           provenance_id::text AS provenance_id
      FROM curve_points
     WHERE curve_id = ${params.curveId}
       AND tenor = ${tenor}
       AND curve_date BETWEEN ${from}::date AND ${to}::date
       AND vintage_at <= ${ctx.asOf.knownAt}::timestamptz
     ORDER BY curve_date, vintage_at DESC`);
  const rows = res.rows.map((row) => ({
    d: row.curve_date,
    v: Number(row.value),
    provenanceId: Number(row.provenance_id),
  }));
  const cite = await citeMany(
    ctx,
    rows.map((r) => r.provenanceId),
    state,
  );
  const obs: GcObservation[] = rows.map((r) => ({ d: r.d, v: Number.isFinite(r.v) ? r.v : null }));
  const firstRow = rows[0];
  return {
    tenor,
    source: 'curve_points',
    seriesCode: null,
    sourceId: 'internal.derived',
    provIdx: firstRow === undefined ? -1 : (cite.get(firstRow.provenanceId) ?? -1),
    unit: 'pct',
    obs,
    coverage: {
      first: obs[0]?.d ?? null,
      last: obs[obs.length - 1]?.d ?? null,
      n: obs.length,
    },
    truncated: obs.length > 0 && (obs[0]?.d ?? '') > from,
  };
}

/** Re-exported for the tests and the screen. */
export type { GcPayload };
