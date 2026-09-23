/**
 * `functions/WB/resolve.ts` — World Bond Markets (FUNCTIONS_TIER2.md §WB L2226-2337).
 *
 * Sixteen government-bond markets on one page, of which exactly one — the United States — has a
 * daily published curve. The other fifteen are the OECD long-term interest rate from FRED, which
 * is **monthly**, and every design decision in this file is about not letting that difference
 * disappear behind a tidy grid:
 *
 *  - `frequency`, `asOfDate` and `lagDays` ride on every row. A print from five weeks ago is
 *    labelled as one; the screen never implies that a monthly OECD observation and today's US par
 *    yield were struck on the same day.
 *  - `chgWindow: '1D'` on a monthly series is `NOT_APPLICABLE`, not a zero and not the last
 *    month's change relabelled. A monthly series has no yesterday.
 *  - The 2Y and 30Y tabs are a **US-only** view. The OECD series is a ten-year benchmark; a
 *    non-US row is `NO_OECD_SERIES_FOR_TENOR`, never the ten-year number under a 30Y heading.
 *  - A series with no stored observation is `NO_RECORDED_FIXTURE` (the series exists, the replay
 *    store has no recorded `fred.csv` response for its provider code) or `NO_SERIES_SEEDED` (there
 *    is no `econ_series` row at all). Neither is interpolated, carried forward from the previous
 *    month, or substituted from a neighbour — §WB step 4 is explicit, and it is the whole point of
 *    a screen that puts sixteen countries next to each other.
 *
 * Sorting follows the same rule: `yield`/`spread`/`chg` sort descending with nulls LAST, so a
 * market with no source sinks to the bottom instead of sorting as a zero yield and appearing to be
 * the tightest market in the world (`sortWbRows`, WB.ts).
 */

import { sql } from 'drizzle-orm';

import type { FieldId, ValueCell, ValueState } from '@terminal/core';
import { monitorColumn } from '@terminal/core';
import { addDays, addMonths, addYears, daysBetween, type IsoDate } from '@terminal/core/calendars/calendar';
import type { CurvePointRow, CurveQuoteType } from '@terminal/core/functions/manifests/BTMM';
import type {
  WbCountry,
  WbCountryRow,
  WbParams,
  WbPayload,
  WbRegion,
  WbUnavailableReason,
  WbUsBlock,
} from '@terminal/core/functions/manifests/WB';
import {
  NO_NON_US_INTRADAY,
  NO_RECORDED_FIXTURE,
  OECD_MONTHLY_LAG,
  sortWbRows,
  WB_COUNTRIES,
  WB_CURVE_DETAIL,
  WB_MONTHLY_CHG_DETAIL,
  WB_TENOR_DETAIL,
  wbFixtureDetail,
  wbSeriesDetail,
} from '@terminal/core/functions/manifests/WB';
import type { MonitorColumn, MonitorRow } from '@terminal/core/functions/shared/monitor';

import type { CurvePoint, CurvePoints } from '../../data/curves.js';
import type { EconObs } from '../../data/econ.js';
import type { ResolveContext } from '../context.js';
import { cellFromState } from '../shared/cells.js';

const US_CURVE = 'UST_PAR';
const US_CURVE_SOURCE = 'treasury.yieldcurve';
const INTRADAY_REF = 'TNX Index';
const OBSERVATION_MONTHS = 18;
/** Six hours, §WB's read-through freshness bound for `fred.series`. */
const SERIES_MAX_AGE_MS = 21_600_000;

const naCell = (provIdx = -1): ValueCell => ({ v: null, st: 'na', provIdx });
const numberOf = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);
const bp = (a: number, b: number): number => Math.round((a - b) * 1000) / 10;

const STATE_RANK: Record<ValueState, number> = { blank: 4, na: 3, stale: 2, closed: 1, live: 0 };
const worseState = (a: ValueState, b: ValueState): ValueState =>
  STATE_RANK[a] >= STATE_RANK[b] ? a : b;

const DICTIONARY_TENORS = new Set([
  '1M',
  '3M',
  '6M',
  '1Y',
  '2Y',
  '3Y',
  '5Y',
  '7Y',
  '10Y',
  '20Y',
  '30Y',
]);
const tenorFieldId = (tenor: string): FieldId | null =>
  DICTIONARY_TENORS.has(tenor) ? (`CRV_${tenor}`) : null;

const CONTEXT_FIELDS: readonly FieldId[] = Object.freeze(['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D']);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The US block (§WB resolver step 2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The compare curve date for a change window: the newest stored date at or before the target. */
function compareDateFor(
  available: readonly string[],
  curveDate: string,
  window: WbParams['chgWindow'],
): string | null {
  if (window === '1D') return available.find((d) => d < curveDate) ?? null;
  const target: IsoDate =
    window === '1W'
      ? addDays(curveDate, -7)
      : window === '1M'
        ? addMonths(curveDate, -1)
        : addYears(curveDate, -1);
  return available.find((d) => d <= target) ?? null;
}

function usCurvePoint(
  ctx: ResolveContext,
  point: CurvePoint,
  compare: CurvePoint | undefined,
): CurvePointRow {
  const provIdx = ctx.prov.add({
    sourceId: US_CURVE_SOURCE,
    provenanceId: point.provenanceId,
    capturedAt: new Date(point.capturedAt),
    sourceTs: point.sourceTs === null ? null : new Date(point.sourceTs),
    st: 'closed',
    tier: 'eod',
  });
  const value: ValueCell = { v: point.value, st: 'closed', provIdx };
  const compareValue: ValueCell =
    compare === undefined ? naCell(provIdx) : { v: compare.value, st: 'closed', provIdx };
  const chgBp: ValueCell =
    compare === undefined
      ? naCell(provIdx)
      : { v: bp(point.value, compare.value), st: 'closed', provIdx };
  return {
    curveId: US_CURVE,
    tenor: point.tenor,
    tenorDays: point.tenorDays,
    quoteType: point.quoteType as CurveQuoteType,
    value,
    compareValue,
    chgBp,
    instrumentId: point.instrumentId,
    cusip: null,
    maturityDate: point.maturityDate,
    onTheRun: false,
    fieldId: tenorFieldId(point.tenor),
    provIdx,
  };
}

/** The Cboe ten-year yield index, read from the plant and never fetched (§0.4 rule 2). */
async function intradayRow(ctx: ResolveContext): Promise<MonitorRow | null> {
  const item = await ctx.data.reference.resolve(INTRADAY_REF);
  const hit = item.instrument;
  if (hit === null) return null;
  const subject = ctx.plant.subjectFor(hit.instrumentId);
  ctx.plant.ensureHot([subject]);
  const state = ctx.plant.snapshotMany([subject]).get(subject);
  const cells: Record<string, ValueCell> = {};
  for (const field of CONTEXT_FIELDS) cells[field] = cellFromState(ctx, state, field, subject);
  return {
    instrumentId: hit.instrumentId,
    key: hit.display,
    name: hit.name,
    assetClass: hit.assetClass,
    marketSector: hit.marketSector,
    exchCode: hit.exchCode,
    gicsSector: null,
    subject,
    cells,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The OECD series (§WB resolver steps 3 and 4)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SeriesRow extends Record<string, unknown> {
  series_code: string;
  provider_code: string;
  country: string;
  units: string;
  frequency: string;
  decimals: number;
  last_updated_at: string | null;
}

/**
 * The `econ_series` rows for the OECD provider codes, keyed by provider code.
 *
 * Keyed by provider code rather than series code because the country table names the FRED code
 * (`IRLTLT01DEM156N`) and `econ_series.series_code` is whatever the ingest chose to call it; a
 * lookup by the code we hold is the only one that cannot silently miss.
 */
async function seriesByProviderCode(
  ctx: ResolveContext,
  providerCodes: readonly string[],
): Promise<Map<string, SeriesRow>> {
  const out = new Map<string, SeriesRow>();
  const want = [...new Set(providerCodes)];
  if (want.length === 0) return out;
  const res = await ctx.db.execute<SeriesRow>(sql`
    SELECT series_code, provider_code, country, units, frequency, decimals,
           to_char(last_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             AS last_updated_at
      FROM econ_series
     WHERE source_id = 'fred.csv'
       AND provider_code = ANY(${sql.param(want)}::text[])`);
  for (const row of res.rows) out.set(row.provider_code, row);
  return out;
}

/** The observation `window` back from `latest`, or `null` when none was published by then. */
function observationBefore(
  observations: readonly EconObs[],
  latest: EconObs,
  window: WbParams['chgWindow'],
): EconObs | null {
  const target: IsoDate =
    window === '1D'
      ? addDays(latest.obsDate, -1)
      : window === '1W'
        ? addDays(latest.obsDate, -7)
        : window === '1M'
          ? addMonths(latest.obsDate, -1)
          : addYears(latest.obsDate, -1);
  let best: EconObs | null = null;
  for (const obs of observations) {
    if (obs.obsDate > target || obs.value === null) continue;
    if (best === null || obs.obsDate > best.obsDate) best = obs;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolve
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: WbParams): Promise<WbPayload> {
  const asOfDay: IsoDate = ctx.asOf.validAt.toISOString().slice(0, 10);
  const notes: string[] = [OECD_MONTHLY_LAG, NO_NON_US_INTRADAY];
  const countries = WB_COUNTRIES.filter(
    (c) => params.region === 'ALL' || c.region === params.region,
  );

  // ── step 2: the US curve and its intraday proxy ───────────────────────────────────────────
  let curve: CurvePoints | null = null;
  try {
    curve = await ctx.data.curves.points(US_CURVE);
  } catch {
    curve = null;
  }
  const compareDate =
    curve === null ? null : compareDateFor(curve.availableDates, curve.curveDate, params.chgWindow);
  let compare: CurvePoints | null = null;
  if (curve !== null && compareDate !== null) {
    try {
      compare = await ctx.data.curves.points(US_CURVE, compareDate);
    } catch {
      compare = null;
    }
  }
  const compareByTenor = new Map((compare?.points ?? []).map((p) => [p.tenor, p]));
  const usPoints = [...(curve?.points ?? [])]
    .sort((a, b) => a.tenorDays - b.tenorDays)
    .map((p) => usCurvePoint(ctx, p, compareByTenor.get(p.tenor)));
  const usByTenor = new Map(usPoints.map((p) => [p.tenor, p]));
  const intraday = await intradayRow(ctx);
  const us: WbUsBlock = {
    curveDate: curve?.curveDate ?? null,
    points: usPoints,
    intraday,
  };
  if (curve === null) {
    ctx.unavailable.add({
      field: 'us.curve',
      reason: 'NO_SOURCE',
      detail: `no stored ${US_CURVE} curve on or before ${asOfDay}`,
    });
  }

  // ── step 3: the OECD rows ─────────────────────────────────────────────────────────────────
  const providerCodes = countries
    .map((c) => c.providerCode)
    .filter((c): c is string => c !== null);
  const seriesRows = params.tenor === '10Y' ? await seriesByProviderCode(ctx, providerCodes) : new Map<string, SeriesRow>();
  const from = addMonths(asOfDay, -OBSERVATION_MONTHS);

  const rows: WbCountryRow[] = [];
  let sawFixtureGap = false;

  for (const country of countries) {
    rows.push(
      country.iso === 'US'
        ? usRow(ctx, country, params, usByTenor, us, intraday)
        : await oecdRow(ctx, country, params, seriesRows, from, asOfDay, (gap) => {
            if (gap === 'NO_RECORDED_FIXTURE') sawFixtureGap = true;
          }),
    );
  }
  if (sawFixtureGap) notes.push(NO_RECORDED_FIXTURE);

  // ── step 5: the spread to the US ──────────────────────────────────────────────────────────
  const usRowValue = rows.find((r) => r.iso === 'US');
  const usYield = usRowValue === undefined ? null : numberOf(usRowValue.yield);
  for (const row of rows) {
    if (params.spreadTo === 'NONE') {
      row.spreadBp = naCell(row.provIdx);
      continue;
    }
    const own = numberOf(row.yield);
    if (own === null || usYield === null || usRowValue === undefined) {
      row.spreadBp = naCell(row.provIdx);
      continue;
    }
    row.spreadBp = {
      v: bp(own, usYield),
      st: worseState(row.yield.st, usRowValue.yield.st),
      provIdx: row.yield.provIdx,
    };
  }

  // A row with no observation has no as-of date, and a publication lag is measured from one — so
  // `lagDays` is blank on exactly those rows. Rule 6 is per cell, so the column says it once; the
  // row's own `yield.<ISO>` entry above names why the observation itself is missing.
  if (rows.some((row) => row.lagDays === null)) {
    ctx.unavailable.add({
      field: 'rows.lagDays',
      reason: 'NOT_APPLICABLE',
      detail:
        'a market with no observation in the window has no as-of date, so there is no publication ' +
        'lag to report; see the yield.<ISO> entry for why that market is empty',
    });
  }

  // ── step 6: regions and sorting ───────────────────────────────────────────────────────────
  const regions: WbPayload['regions'] = (['AMERICAS', 'EMEA', 'APAC'] as WbRegion[])
    .map((region) => {
      const inRegion = rows.filter((r) => r.region === region);
      return {
        region,
        count: inRegion.length,
        withData: inRegion.filter((r) => r.yield.v !== null).length,
      };
    })
    .filter((r) => r.count > 0);

  return {
    variant: 'default',
    tenor: params.tenor,
    chgWindow: params.chgWindow,
    spreadTo: params.spreadTo,
    us,
    rows: sortWbRows(rows, params.sort),
    regions,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

function usRow(
  ctx: ResolveContext,
  country: WbCountry,
  params: WbParams,
  byTenor: Map<string, CurvePointRow>,
  us: WbUsBlock,
  intraday: MonitorRow | null,
): WbCountryRow {
  const point = byTenor.get(params.tenor);
  const yieldCell = point?.value ?? naCell();
  const chgBp = point?.chgBp ?? naCell(yieldCell.provIdx);
  if (point === undefined) {
    ctx.unavailable.add({
      field: `yield.US`,
      reason: 'NO_SOURCE',
      detail: `tenor ${params.tenor} absent from the Treasury publication for this curve date`,
    });
  }
  const asOfDate = us.curveDate;
  return {
    iso: country.iso,
    country: country.name,
    region: country.region,
    ccy: country.ccy,
    tenor: params.tenor,
    seriesCode: null,
    sourceId: point === undefined ? null : 'treasury.yieldcurve',
    frequency: 'D',
    yield: yieldCell,
    asOfDate,
    chgBp,
    spreadBp: naCell(yieldCell.provIdx),
    curve: {
      t2y: byTenor.get('2Y')?.value ?? naCell(),
      t10y: byTenor.get('10Y')?.value ?? naCell(),
      t30y: byTenor.get('30Y')?.value ?? naCell(),
    },
    subject: intraday?.subject ?? null,
    lagDays: asOfDate === null ? null : lagOf(asOfDate, ctx),
    provIdx: yieldCell.provIdx,
    unavailableReason: point === undefined ? 'NO_SERIES_SEEDED' : null,
  };
}

async function oecdRow(
  ctx: ResolveContext,
  country: WbCountry,
  params: WbParams,
  seriesRows: Map<string, SeriesRow>,
  from: string,
  asOfDay: string,
  onGap: (reason: WbUnavailableReason) => void,
): Promise<WbCountryRow> {
  const providerCode = country.providerCode ?? '';
  const base: WbCountryRow = {
    iso: country.iso,
    country: country.name,
    region: country.region,
    ccy: country.ccy,
    tenor: params.tenor,
    seriesCode: null,
    sourceId: null,
    frequency: null,
    yield: naCell(),
    asOfDate: null,
    chgBp: naCell(),
    spreadBp: naCell(),
    curve: { t2y: naCell(), t10y: naCell(), t30y: naCell() },
    subject: null,
    lagDays: null,
    provIdx: -1,
    unavailableReason: null,
  };

  // §WB step 3: the 2Y and 30Y tabs are a US-only view — the OECD series is a ten-year benchmark
  // and no substitute tenor is shown in its place.
  ctx.unavailable.add({ field: `curve.${country.iso}`, reason: 'NO_SOURCE', detail: WB_CURVE_DETAIL });
  if (params.tenor !== '10Y') {
    ctx.unavailable.add({
      field: `yield.${country.iso}`,
      reason: 'NO_SOURCE',
      detail: WB_TENOR_DETAIL,
    });
    return { ...base, unavailableReason: 'NO_OECD_SERIES_FOR_TENOR' };
  }

  const series = seriesRows.get(providerCode);
  if (series === undefined) {
    ctx.unavailable.add({
      field: `yield.${country.iso}`,
      reason: 'NO_SOURCE',
      detail: wbSeriesDetail(providerCode),
    });
    onGap('NO_SERIES_SEEDED');
    return { ...base, unavailableReason: 'NO_SERIES_SEEDED' };
  }

  // §WB read-through: only a series whose provider code has a recorded fixture can be refreshed.
  // In `PROVIDER_MODE=replay` a miss throws in the replay store, which is the wall the brief
  // describes; the row then states the gap instead of the resolver failing the screen.
  const stale =
    series.last_updated_at === null ||
    ctx.clock.now() - Date.parse(series.last_updated_at) > SERIES_MAX_AGE_MS;
  if (stale && ctx.usage !== 'export') {
    try {
      await ctx.providers.ensure('fred.series', series.series_code, {
        maxAgeMs: SERIES_MAX_AGE_MS,
      });
    } catch {
      // A replay-store miss or an open circuit leaves whatever is stored on screen.
    }
  }

  const observations = await ctx.data.econ.observations(series.series_code, {
    from,
    to: asOfDay,
    knownAt: ctx.asOf.knownAt,
  });
  const withValue = observations.filter((o) => o.value !== null);
  const latest = withValue[withValue.length - 1];
  if (latest?.value == null) {
    ctx.unavailable.add({
      field: `yield.${country.iso}`,
      reason: 'NO_SOURCE',
      detail: wbFixtureDetail(providerCode),
    });
    onGap('NO_RECORDED_FIXTURE');
    return {
      ...base,
      seriesCode: series.series_code,
      sourceId: 'fred.csv',
      frequency: 'M',
      subject: `e:${series.series_code}`,
      unavailableReason: 'NO_RECORDED_FIXTURE',
    };
  }

  const provIdx = ctx.prov.add({
    sourceId: 'fred.csv',
    provenanceId: latest.provenanceId,
    capturedAt: new Date(latest.vintageAt),
    sourceTs: null,
    st: 'closed',
    tier: 'eod',
  });
  const ts = Date.parse(`${latest.obsDate}T00:00:00.000Z`);
  const yieldCell: ValueCell = { v: latest.value, st: 'closed', ts, provIdx };

  // A monthly series has no yesterday: `1D` is NOT_APPLICABLE, never a zero (§WB step 3).
  let chgBp: ValueCell = naCell(provIdx);
  if (params.chgWindow === '1D') {
    ctx.unavailable.add({
      field: `chgBp.${country.iso}`,
      reason: 'NOT_APPLICABLE',
      detail: WB_MONTHLY_CHG_DETAIL,
    });
  } else {
    const previous = observationBefore(withValue, latest, params.chgWindow);
    if (previous?.value == null) {
      ctx.unavailable.add({
        field: `chgBp.${country.iso}`,
        reason: 'NO_SOURCE',
        detail: `no ${params.chgWindow} comparison observation stored for ${series.series_code}`,
      });
    } else {
      chgBp = { v: bp(latest.value, previous.value), st: 'closed', ts, provIdx };
    }
  }

  return {
    ...base,
    seriesCode: series.series_code,
    sourceId: 'fred.csv',
    frequency: 'M',
    yield: yieldCell,
    asOfDate: latest.obsDate,
    chgBp,
    subject: `e:${series.series_code}`,
    lagDays: lagOf(latest.obsDate, ctx),
    provIdx,
  };
}

function lagOf(date: string, ctx: ResolveContext): number {
  return daysBetween(date, ctx.asOf.validAt.toISOString().slice(0, 10));
}

/** The `us.intraday` grid's columns, derived from the dictionary once. */
export const WB_INTRADAY_COLUMNS: MonitorColumn[] = CONTEXT_FIELDS.map((f) => monitorColumn(f));
