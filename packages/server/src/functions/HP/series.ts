/**
 * `functions/HP/series.ts` — the `series` variant of HP (§HP resolver step 5).
 *
 * Three families that share one screen because they share one shape: a published observation with
 * a date, a value, and the vintage it was published in. They do **not** share a source.
 *
 *  - **govt** — the on-the-run tenor's curve history from `curve_points`. Bills carry two columns
 *    (`discount_rate` and the bond-equivalent `investment_yield`), notes and bonds one (the par
 *    yield of their tenor). A CUSIP with no `term_label` is off the run and has no curve series at
 *    all; that is `NO_SOURCE`, not an empty table with no explanation.
 *  - **rate** — `rate_fixings` history, value plus the four percentiles and the volume.
 *  - **econ** — `econ_observations` at `vintage_at ≤ knownAt`, which is the whole point of the
 *    variant: a revision is a *new vintage*, so a read as of last month legitimately returns the
 *    number that was published then (STOR-06).
 *
 * `data.curves` has `points(curveId, date)` and `build(...)` but no history reader — FUNCTIONS_TIER1
 * §HP names `data.curves.history(...)` as an addition WP-04 was to make and did not. Rather than
 * fetching one curve date at a time (a `SELECT` per session), the govt reader goes through
 * `ctx.db`, the request transaction, which is the same handle the service would have used and is
 * the access FUNCTIONS.md §1.4.1 grants a resolver for exactly this case (§GP does the same for
 * `chart_annotations`). It is recorded as a deviation rather than papered over.
 */

import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import { curvePoints } from '../../db/schema/curves.js';
import { govtTerms } from '../../db/schema/terms.js';
import { toSummary } from '../shared/instrumentSummary.js';

import type {
  HpColumn,
  HpParams,
  HpSeriesPayload,
  HpSeriesRow,
} from '@terminal/core/functions/manifests/HP';
import { hpColumn } from '@terminal/core/functions/manifests/HP';
import type { FieldId } from '@terminal/core';

import type { InstrumentDetail } from '../../data/reference.js';
import type { ResolveContext } from '../context.js';

/** One observation before it is projected onto `columns`. */
interface Observation {
  date: string;
  values: (number | null)[];
  status: HpSeriesRow['status'];
  vintageAt: string | null;
  provenanceId: number;
  provIdx: number;
}

export interface SeriesInput {
  ctx: ResolveContext;
  params: HpParams;
  detail: InstrumentDetail;
  window: { start: string; end: string; range: HpParams['range'] };
}

export interface SeriesBody {
  series: HpSeriesPayload['series'];
  columns: HpColumn[];
  observations: Observation[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// govt
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `'4WK'`, `'13WK'`, `'26WK'`, `'52WK'` — the bill tenors `UST_BILL` is quoted on. */
const BILL_TENOR = /^\d+WK$/;

async function govtSeries(input: SeriesInput): Promise<SeriesBody> {
  const { ctx, detail, window } = input;
  const instrumentId = detail.instrument.instrumentId;

  const terms = await ctx.db
    .select({ termLabel: govtTerms.termLabel, securityType: govtTerms.securityType })
    .from(govtTerms)
    .where(eq(govtTerms.instrumentId, instrumentId))
    .orderBy(sql`${govtTerms.versionId} DESC`)
    .limit(1);

  const tenor = terms[0]?.termLabel ?? null;
  if (tenor === null || tenor.trim() === '') {
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: 'no price history for off-the-run Treasuries',
    });
    return {
      series: {
        kind: 'govt',
        code: detail.instrument.ticker,
        name: detail.instrument.name,
        units: 'Percent',
        frequency: 'D',
        sourceId: 'treasury.yieldcurve',
        curveId: null,
        tenor: null,
      },
      columns: [],
      observations: [],
    };
  }

  const isBill = BILL_TENOR.test(tenor);
  const curveId = isBill ? 'UST_BILL' : 'UST_PAR';
  const sourceId = isBill ? 'treasury.bills' : 'treasury.yieldcurve';
  // A bill is published twice — on the discount basis and on the bond-equivalent basis — and both
  // are columns. A note has one quote type, the par yield of its tenor.
  const quoteTypes = isBill ? ['discount_rate', 'investment_yield'] : ['par_yield'];
  const columns: HpColumn[] = isBill
    ? [hpColumn('DISC_RATE'), hpColumn('BEY')]
    : [{ ...hpColumn('CURVE_PAR'), label: `Par yield ${tenor}` }];

  const rows = await ctx.db
    .select({
      curveDate: curvePoints.curveDate,
      quoteType: curvePoints.quoteType,
      value: curvePoints.value,
      vintageAt: curvePoints.vintageAt,
      provenanceId: curvePoints.provenanceId,
    })
    .from(curvePoints)
    .where(
      and(
        eq(curvePoints.curveId, curveId),
        eq(curvePoints.tenor, tenor),
        gte(curvePoints.curveDate, window.start),
        lte(curvePoints.curveDate, window.end),
        lte(curvePoints.vintageAt, ctx.asOf.knownAt),
      ),
    )
    .orderBy(asc(curvePoints.curveDate), asc(curvePoints.vintageAt));

  // One row per curve date; a later vintage of the same (date, quote type) supersedes an earlier
  // one, which is what ordering ascending by `vintage_at` and overwriting gives.
  const byDate = new Map<string, Observation>();
  for (const row of rows) {
    const at = quoteTypes.indexOf(row.quoteType);
    if (at < 0) continue;
    const provIdx = ctx.prov.add({
      sourceId,
      provenanceId: row.provenanceId,
      capturedAt: row.vintageAt,
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    const existing = byDate.get(row.curveDate) ?? {
      date: row.curveDate,
      values: quoteTypes.map(() => null),
      status: 'final' as const,
      vintageAt: row.vintageAt.toISOString(),
      provenanceId: row.provenanceId,
      provIdx,
    };
    existing.values[at] = Number(row.value);
    existing.vintageAt = row.vintageAt.toISOString();
    existing.provIdx = provIdx;
    byDate.set(row.curveDate, existing);
  }

  const observations = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (observations.length === 0) {
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: `no curve points for ${curveId} ${tenor} in the window`,
    });
  }

  return {
    series: {
      kind: 'govt',
      code: detail.instrument.ticker,
      name: detail.instrument.name,
      units: 'Percent',
      frequency: 'D',
      sourceId,
      curveId,
      tenor,
    },
    columns,
    observations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// rate
// ─────────────────────────────────────────────────────────────────────────────────────────────

const RATE_COLUMNS: readonly FieldId[] = [
  'RATE',
  'RATE_P1',
  'RATE_P25',
  'RATE_P75',
  'RATE_P99',
  'RATE_VOLUME_BN',
];

async function rateSeries(input: SeriesInput): Promise<SeriesBody> {
  const { ctx, detail, window } = input;
  const code = detail.instrument.ticker;

  // `rates.history(code, days)` counts back from today; ask for the whole window plus a margin
  // and filter to it, because a rate calendar is not a session calendar.
  const span = Math.max(
    1,
    Math.ceil(
      (Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) / 86_400_000,
    ) + 1,
  );
  const fixings = await ctx.data.rates.history(code, span);

  const observations: Observation[] = [];
  for (const fixing of fixings) {
    if (fixing.effectiveDate < window.start || fixing.effectiveDate > window.end) continue;
    if (Date.parse(fixing.vintageAt) > ctx.asOf.knownAt.getTime()) continue;
    const provIdx = ctx.prov.add({
      sourceId: 'nyfed.rates',
      provenanceId: fixing.provenanceId,
      capturedAt: new Date(fixing.capturedAt),
      sourceTs: fixing.sourceTs === null ? null : new Date(fixing.sourceTs),
      st: 'closed',
      tier: 'eod',
    });
    observations.push({
      date: fixing.effectiveDate,
      values: [fixing.rate, fixing.pct1, fixing.pct25, fixing.pct75, fixing.pct99, fixing.volumeBn],
      status: fixing.revisionIndicator === null ? 'final' : 'revised',
      vintageAt: fixing.vintageAt,
      provenanceId: fixing.provenanceId,
      provIdx,
    });
  }
  observations.sort((a, b) => (a.date < b.date ? -1 : 1));

  if (observations.length === 0) {
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: `no ${code} fixings in the window`,
    });
  }

  return {
    series: {
      kind: 'rate',
      code,
      name: detail.instrument.name,
      units: 'Percent',
      frequency: 'D',
      sourceId: 'nyfed.rates',
      curveId: null,
      tenor: null,
    },
    columns: RATE_COLUMNS.map((id) => hpColumn(id)),
    observations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// econ
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function econSeries(input: SeriesInput): Promise<SeriesBody> {
  const { ctx, detail, window } = input;
  const instrumentId = detail.instrument.instrumentId;

  const meta =
    (await ctx.data.econ.seriesForInstrument(instrumentId)) ??
    (await ctx.data.econ.series(detail.instrument.ticker));

  if (meta === null) {
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: `no econ_series row for ${detail.instrument.ticker}`,
    });
    return {
      series: {
        kind: 'econ',
        code: detail.instrument.ticker,
        name: detail.instrument.name,
        units: '',
        frequency: 'M',
        sourceId: 'fred.csv',
        curveId: null,
        tenor: null,
      },
      columns: [hpColumn('ECO_VALUE')],
      observations: [],
    };
  }

  const obs = await ctx.data.econ.observations(meta.seriesCode, {
    from: window.start,
    to: window.end,
    knownAt: ctx.asOf.knownAt,
  });

  const observations: Observation[] = obs.map((o) => ({
    date: o.obsDate,
    values: [o.value],
    status: o.status,
    vintageAt: o.vintageAt,
    provenanceId: o.provenanceId,
    provIdx: ctx.prov.add({
      sourceId: meta.sourceId,
      provenanceId: o.provenanceId,
      capturedAt: new Date(o.vintageAt),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    }),
  }));

  if (observations.length === 0) {
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: `no observations for ${meta.seriesCode} in the window as known at ${ctx.asOf.knownAt.toISOString()}`,
    });
  }
  // A published gap is `status:'missing'` with a null value — never interpolated, and never
  // silently blank (§1.3 rule 6).
  if (observations.some((o) => o.values[0] === null)) {
    ctx.unavailable.add({
      field: 'ECO_VALUE',
      reason: 'NO_SOURCE',
      detail: 'the publisher reported no value for at least one period in the window',
    });
  }

  return {
    series: {
      kind: 'econ',
      code: meta.seriesCode,
      name: meta.name,
      units: meta.units,
      frequency: meta.frequency,
      sourceId: meta.sourceId,
      curveId: null,
      tenor: null,
    },
    columns: [hpColumn('ECO_VALUE')],
    observations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The variant
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Roll a daily observation series up to W/M/Q/Y: the last observation of each period. */
function resample(observations: readonly Observation[], periodicity: HpParams['periodicity']): Observation[] {
  if (periodicity === 'D') return [...observations];
  const out = new Map<string, Observation>();
  for (const o of observations) out.set(bucketKey(o.date, periodicity), o);
  return [...out.values()];
}

function bucketKey(date: string, periodicity: 'W' | 'M' | 'Q' | 'Y'): string {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  if (periodicity === 'Y') return year;
  if (periodicity === 'Q') return `${year}Q${String(Math.ceil(month / 3))}`;
  if (periodicity === 'M') return `${year}-${date.slice(5, 7)}`;
  // ISO week: Thursday of the week decides the year, which is what `Date`'s UTC day arithmetic
  // gives when the day-of-week is normalised with Monday as 1.
  const at = new Date(`${date}T00:00:00.000Z`);
  const day = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  at.setUTCDate(at.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(at.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((at.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${String(at.getUTCFullYear())}W${String(week).padStart(2, '0')}`;
}

export async function resolveSeriesVariant(input: SeriesInput): Promise<HpSeriesPayload> {
  const { ctx, params, detail, window } = input;
  const assetClass = detail.instrument.assetClass;

  const body =
    assetClass === 'govt'
      ? await govtSeries(input)
      : assetClass === 'rate'
        ? await rateSeries(input)
        : await econSeries(input);

  // A monthly series asked for at `D` is served as published: there is nothing between the months
  // to show, and inventing daily points would be a fabricated number.
  const effective =
    body.series.frequency !== 'D' && params.periodicity === 'D'
      ? body.observations
      : resample(body.observations, params.periodicity);

  const ordered = [...effective].sort((a, b) => (a.date < b.date ? -1 : 1));

  const rows: HpSeriesRow[] = ordered.map((o, i) => {
    const previous = ordered[i - 1]?.values[0] ?? null;
    const value = o.values[0] ?? null;
    const chgAbs = previous === null || value === null ? null : value - previous;
    const chgPct =
      previous === null || previous === 0 || value === null ? null : (value / previous - 1) * 100;
    return {
      date: o.date,
      v: [...o.values],
      status: o.status,
      vintageAt: o.vintageAt,
      chgAbs,
      chgPct,
    };
  });

  // Rule 6 is per cell: a change that could not be computed is a `null` a user can hover over, so
  // the column says once why some of its rows are blank. There are exactly three reasons and none
  // of them is a missing source — the first row of the window has no predecessor, a published gap
  // (`status:'missing'`) has no level to difference, and a zero previous level has no percentage.
  // HP never interpolates across any of them (FUNCTIONS_TIER1 §HP).
  const CHANGE_DETAIL =
    'not computed on the first row of the window, across a published gap (status:"missing"), ' +
    'or where the previous level is zero — a change is never interpolated';
  if (rows.some((row) => row.chgAbs === null)) {
    ctx.unavailable.add({ field: 'rows.chgAbs', reason: 'NOT_APPLICABLE', detail: CHANGE_DETAIL });
  }
  if (rows.some((row) => row.chgPct === null)) {
    ctx.unavailable.add({ field: 'rows.chgPct', reason: 'NOT_APPLICABLE', detail: CHANGE_DETAIL });
  }

  const levels = ordered
    .map((o) => ({ date: o.date, v: o.values[0] ?? null }))
    .filter((p): p is { date: string; v: number } => p.v !== null);

  const highest = levels.reduce<{ date: string; v: number } | null>(
    (best, p) => (best === null || p.v > best.v ? p : best),
    null,
  );
  const lowest = levels.reduce<{ date: string; v: number } | null>(
    (best, p) => (best === null || p.v < best.v ? p : best),
    null,
  );
  const first = levels[0]?.v ?? null;
  const last = levels.at(-1)?.v ?? null;

  const payload: HpSeriesPayload = {
    variant: 'series',
    instrument: toSummary(detail),
    series: body.series,
    columns: body.columns,
    rows,
    summary: {
      first,
      last,
      high: highest?.v ?? null,
      highDate: highest?.date ?? null,
      low: lowest?.v ?? null,
      lowDate: lowest?.date ?? null,
      changeAbs: first === null || last === null ? null : last - first,
      changePct: first === null || first === 0 || last === null ? null : (last / first - 1) * 100,
      observations: rows.length,
    },
    window,
    periodicity: params.periodicity,
    knownAt: ctx.asOf.knownAt.toISOString(),
    provIdx: [...new Set(ordered.map((o) => o.provIdx))].sort((a, b) => a - b),
  };

  if (payload.summary.first === null) {
    ctx.unavailable.add({
      field: 'summary',
      reason: 'NO_SOURCE',
      detail: 'no observation carried a value in the window',
    });
  }

  return payload;
}
