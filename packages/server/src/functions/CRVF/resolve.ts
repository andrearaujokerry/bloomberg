/**
 * `functions/CRVF/resolve.ts` — Curve Construction (FUNCTIONS_TIER3.md §CRVF L227-363).
 *
 * The build is the product. `data/curves.ts#build` (WP-04) hashes the engine input set *before*
 * the bootstrap runs, looks the hash up in `curve_builds`, and either re-hydrates the stored nodes
 * or bootstraps once and inserts — so this resolver's job is to ask for the build, cite what went
 * into it and present what came out, never to compute a curve of its own (ANAL-02, ANAL-08). The
 * `buildId`, the `inputsHash` and the engine name@version are in the payload because they are the
 * screen's claim to reproducibility: two runs a week apart quote the same row.
 *
 * Three decisions:
 *
 *  1. **`SOFR_FIX` is not bootstrapped.** It stores one overnight fixing; `methodFor('fixing')`
 *     would send it down the par bootstrap, which consumes no `fixing` points and would raise.
 *     `build.method` is `'none'`, the single node carries the fixing, and everything beyond ON is
 *     `null` with `FIXING_ONLY_NO_TERM_STRUCTURE` — not a flat curve invented from one number.
 *  2. **A par rate needs a whole number of coupon periods.** `impliedParRate` prices the coupon
 *     bond the bootstrap solved; a 1-month node is not one. Those nodes report `par: null` with a
 *     `NOT_APPLICABLE` note and keep `zero`/`df`, rather than printing a money-market rate in the
 *     par column where a desk would read it as a bond yield.
 *  3. **A comparison date with no stored curve is dropped with a reason**, and the payload is
 *     still a 200: the main curve is what the screen is for.
 */

import { sql } from 'drizzle-orm';

import type { ValueCell } from '@terminal/core';
import {
  addMonths,
  daysBetween,
  getCalendar,
  type IsoDate,
} from '@terminal/core/calendars/calendar';
import {
  icmaYearFraction,
  impliedParRate,
  oisParRate,
  oisScheduleOf,
  parScheduleOf,
} from '@terminal/core/analytics/curve/bootstrap';
import type { Curve } from '@terminal/core/analytics/curve/curve';
import type { DayCountId } from '@terminal/core/daycount/conventions';
import type {
  CrvfBuildBlock,
  CrvfCaveat,
  CrvfChange,
  CrvfCompare,
  CrvfCompareNode,
  CrvfInputRow,
  CrvfNode,
  CrvfParams,
  CrvfPayload,
} from '@terminal/core/functions/manifests/CRVF';
import {
  CRVF_BOOTSTRAP_DETAIL,
  CRVF_FIXING_DETAIL,
  CRVF_PROXY_DETAIL,
} from '@terminal/core/functions/manifests/CRVF';

import type { CurveBuild, CurvePoints } from '../../data/curves.js';
import { AppError } from '../../http/errors.js';
import type { ResolveContext } from '../context.js';
import { displayOf } from '../shared/instrumentSummary.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const cell = (v: number, provIdx: number): ValueCell => ({ v, st: 'closed', provIdx, ts: null });

type ProvRow = {
  provenance_id: string;
  source_id: string;
  captured_at: string;
  source_ts: string | null;
};

/** Register every `provenance_id` this payload names; a data service's own idx is a different list. */
async function citeMany(
  ctx: ResolveContext,
  ids: readonly number[],
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
        st: 'closed',
        tier: 'eod',
      }),
    );
  }
  return out;
}

type InstrumentRow = {
  instrument_id: string;
  ticker: string;
  exch_code: string;
  market_sector: string;
};

/** `instrument_id → 'T 4.25 08/15/36 Govt'` for the input rows, in one query. */
async function instrumentKeys(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const want = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (want.length === 0) return out;
  const list = sql.join(
    want.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<InstrumentRow>(sql`
    SELECT instrument_id::text AS instrument_id, ticker, exch_code, market_sector
      FROM instruments
     WHERE instrument_id IN (${list})
       AND valid_from <= ${ctx.asOf.validAt}::timestamptz
       AND valid_to   >  ${ctx.asOf.validAt}::timestamptz
       AND tx_from    <= ${ctx.asOf.knownAt}::timestamptz
       AND tx_to      >  ${ctx.asOf.knownAt}::timestamptz`);
  for (const row of res.rows) {
    out.set(
      Number(row.instrument_id),
      displayOf(row.ticker, row.exch_code, row.market_sector as Parameters<typeof displayOf>[2]),
    );
  }
  return out;
}

/** The ISO day of an instant in New York. */
function nyDate(at: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * A date on the curve's own time axis, for a node the build did **not** solve (a monthly or
 * quarterly grid point). An input node takes its `t` from the build itself — see
 * {@link inputTimesOf}, and the note there for why a day count of the published `tenor_days` is
 * not the same number.
 */
function timeOf(curveDate: IsoDate, date: IsoDate, dayCount: string, frequency: number): number {
  if (dayCount === 'ACT/360') return daysBetween(curveDate, date) / 360;
  if (dayCount === 'ACT/365F') return daysBetween(curveDate, date) / 365;
  return icmaYearFraction(curveDate, date, frequency);
}

/** `'2Y'` → 24, `'6M'` → 6, `'4WK'`/`'1.5M'` → `null` (not a whole number of months). */
function tenorMonths(tenor: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(M|Y)$/.exec(tenor.trim().toUpperCase());
  if (match === null) return null;
  const n = Number(match[1]);
  const months = match[2] === 'Y' ? n * 12 : n;
  return Number.isInteger(months) ? months : null;
}

/**
 * `tenor → the year fraction the bootstrap solved that node at`.
 *
 * The published `tenor_days` is a *label*: the Treasury's 2Y point carries 730 days, while the
 * bond the bootstrap priced matures two calendar years out — 731 days across a leap year. Taking
 * `t` from the label therefore shifts every node by up to a day, and a curve rebuilt from those
 * shifted nodes no longer reprices its own inputs (about 1e-5 of price at 5Y, which is exactly the
 * kind of quiet wrongness the acceptance test exists to catch). `curve_builds.inputs` and
 * `curve_builds.nodes` are both ascending in `t` and one-to-one — the engine appends one node per
 * consumed instrument — so the k-th consumed input is the k-th node, and that is the number the
 * payload reports.
 */
function inputTimesOf(build: CurveBuild): Map<string, number> {
  const out = new Map<string, number>();
  if (build.inputs.length !== build.nodes.length) return out;
  const ordered = [...build.inputs].sort((a, b) => a.tenorDays - b.tenorDays);
  ordered.forEach((input, i) => {
    const node = build.nodes[i];
    if (node !== undefined) out.set(input.tenor, node.t);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface NodeContext {
  curveDate: IsoDate;
  dayCount: string;
  compounding: string;
  kind: string;
  frequency: number;
  curve: Curve;
  lastT: number;
}

/** The par rate of a node, or `null` when the tenor is not a whole number of coupon periods. */
function parRateOf(nc: NodeContext, tenor: string): number | null {
  const months = tenorMonths(tenor);
  if (months === null) return null;
  try {
    if (nc.kind === 'ois') {
      if (months % 12 !== 0) return null;
      const schedule = oisScheduleOf(nc.curveDate, tenor, {
        fixedFrequency: 1,
        settlementDays: 2,
        businessDayConvention: 'modified_following',
        calendar: getCalendar('SIFMA'),
      });
      return oisParRate(nc.curve, schedule) * 100;
    }
    if (months % (12 / nc.frequency) !== 0) return null;
    const schedule = parScheduleOf(
      nc.curveDate,
      tenor,
      nc.frequency,
      (nc.dayCount as DayCountId) ?? 'ACT/ACT',
    );
    return impliedParRate(nc.curve, schedule) * 100;
  } catch {
    // A tenor the schedule builder refuses is a tenor with no par bond; the column stays blank and
    // the caller records the reason once.
    return null;
  }
}

interface TenorPoint {
  tenor: string;
  days: number;
}

/** The tenors of the node table: the input grid, or a regular one out to 30 years. */
function gridTenors(params: CrvfParams, points: CurvePoints, curveDate: IsoDate): TenorPoint[] {
  if (params.grid === 'inputs') {
    const seen = new Map<number, TenorPoint>();
    for (const point of points.points) {
      if (!seen.has(point.tenorDays)) {
        seen.set(point.tenorDays, { tenor: point.tenor, days: point.tenorDays });
      }
    }
    return [...seen.values()].sort((a, b) => a.days - b.days);
  }
  const step = params.grid === 'monthly' ? 1 : 3;
  const out: TenorPoint[] = [];
  for (let months = step; months <= 360; months += step) {
    const date = addMonths(curveDate, months);
    out.push({ tenor: `${String(months)}M`, days: daysBetween(curveDate, date) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const code = 'CRVF';

export async function resolve(ctx: ResolveContext, params: CrvfParams): Promise<CrvfPayload> {
  const valuationDate = nyDate(ctx.asOf.validAt);
  const wanted = params.date ?? valuationDate;

  const points = await ctx.data.curves.points(params.curveId, wanted).catch(() => null);
  if (points === null || points.points.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `no ${params.curveId} curve on or before ${wanted}.`,
      { details: { location: 'fnParams', field: 'date' } },
    );
  }

  const cite = await citeMany(
    ctx,
    points.points.map((p) => p.provenanceId),
  );
  const firstPoint = points.points[0]!;
  const provIdxCurve = cite.get(firstPoint.provenanceId) ?? -1;

  const interpolation = params.interpolation ?? points.defaultInterpolation;
  const caveats: CrvfCaveat[] = [];
  const build =
    points.kind === 'fixing'
      ? null
      : await ctx.data.curves
          .build(params.curveId, points.curveDate, interpolation)
          .catch((err: unknown) => {
            // Decision 4: the published inputs are real even when the bootstrap cannot consume
            // them. The screen keeps them, names the reason and drops the node table.
            caveats.push('BOOTSTRAP_UNAVAILABLE');
            ctx.unavailable.add({
              field: 'nodes',
              reason: 'NO_SOURCE',
              detail: `${CRVF_BOOTSTRAP_DETAIL}: ${err instanceof Error ? err.message : String(err)}`,
            });
            return null;
          });
  if (build !== null) ctx.engines.add(build.engine);

  if (params.curveId === 'SOFR_OIS') {
    caveats.push('PROXY_CURVE', 'NO_OIS_SWAP_QUOTES_SOURCE');
    ctx.unavailable.add({
      field: 'inputs.proxy',
      reason: 'NO_SOURCE',
      detail: CRVF_PROXY_DETAIL,
    });
  }
  if (points.kind === 'fixing') {
    caveats.push('FIXING_ONLY_NO_TERM_STRUCTURE');
    ctx.unavailable.add({
      field: 'nodes',
      reason: 'NOT_APPLICABLE',
      detail: CRVF_FIXING_DETAIL,
    });
  }

  // ── inputs ──────────────────────────────────────────────────────────────────────────────────
  const keys = await instrumentKeys(
    ctx,
    points.points.flatMap((p) => (p.instrumentId === null ? [] : [p.instrumentId])),
  );
  const buildInputs = new Map(
    (build?.inputs ?? []).map((row) => [`${row.tenor}|${row.quoteType}`, row]),
  );
  const inputs: CrvfInputRow[] = points.points.map((point) => {
    const consumed = buildInputs.get(`${point.tenor}|${point.quoteType}`);
    const provIdx = cite.get(point.provenanceId) ?? -1;
    const key = point.instrumentId === null ? undefined : keys.get(point.instrumentId);
    return {
      tenor: point.tenor,
      tenorDays: point.tenorDays,
      quoteType: point.quoteType,
      value: cell(point.value, provIdx),
      instrument:
        point.instrumentId === null || key === undefined
          ? null
          : { instrumentId: point.instrumentId, key },
      maturityDate: point.maturityDate,
      proxy: consumed?.proxy ?? false,
      proxyOf: consumed?.proxy === true ? consumed.sourceId : null,
      provIdx,
    };
  });

  // ── nodes ───────────────────────────────────────────────────────────────────────────────────
  const curveDate = points.curveDate;
  const inputDays = new Set(points.points.map((p) => p.tenorDays));
  const tenors = gridTenors(params, points, curveDate);
  const nodes: CrvfNode[] = [];
  let parGaps = 0;
  let fwd3mGaps = 0;
  let fwd1yGaps = 0;

  if (build === null) {
    // `SOFR_FIX`, or a tenor set the bootstrap cannot consume: what was published is all that is
    // known, and nothing beyond it is invented. Every derived column is explained by name.
    for (const column of ['par', 'zero', 'df', 'fwd3m', 'fwd1y']) {
      ctx.unavailable.add({
        field: `nodes.${column}`,
        reason: 'NO_SOURCE',
        detail: 'no bootstrapped curve for this date, so the derived columns are blank',
      });
    }
    for (const tenor of tenors) {
      nodes.push({
        tenor: tenor.tenor,
        t: timeOf(curveDate, addDaysIso(curveDate, tenor.days), points.dayCount, 2),
        days: tenor.days,
        par: null,
        zero: null,
        df: null,
        fwd3m: null,
        fwd1y: null,
        isInput: inputDays.has(tenor.days),
      });
    }
  } else {
    const frequency = points.compounding === 'annual' || points.kind === 'ois' ? 1 : 2;
    const lastT = build.curve.times[build.curve.times.length - 1] ?? 0;
    const nc: NodeContext = {
      curveDate,
      dayCount: points.dayCount,
      compounding: points.compounding,
      kind: points.kind,
      frequency,
      curve: build.curve,
      lastT,
    };
    const inputTimes = inputTimesOf(build);
    for (const tenor of tenors) {
      const t =
        inputTimes.get(tenor.tenor) ??
        timeOf(curveDate, addDaysIso(curveDate, tenor.days), points.dayCount, frequency);
      const par = parRateOf(nc, tenor.tenor);
      if (par === null) parGaps += 1;
      const fwd3m = t + 0.25 <= lastT ? build.curve.fwd(t, t + 0.25) * 100 : null;
      const fwd1y = t + 1 <= lastT ? build.curve.fwd(t, t + 1) * 100 : null;
      if (fwd3m === null) fwd3mGaps += 1;
      if (fwd1y === null) fwd1yGaps += 1;
      nodes.push({
        tenor: tenor.tenor,
        t,
        days: tenor.days,
        par,
        zero: build.curve.zero(t) * 100,
        df: build.curve.df(t),
        fwd3m,
        fwd1y,
        isInput: inputDays.has(tenor.days),
      });
    }
  }
  if (parGaps > 0) {
    ctx.unavailable.add({
      field: 'nodes.par',
      reason: 'NOT_APPLICABLE',
      detail:
        'a par rate is the coupon of a bond with a whole number of coupon periods; money-market ' +
        'and odd tenors have none and are left blank rather than quoted as a bond yield',
    });
  }
  // One entry per column, not one for the pair: the runner matches a gap against the explanation
  // that names *that* cell, and `nodes.fwd` explains neither `fwd3m` nor `fwd1y` (DATA-10).
  const FWD_DETAIL = 'a forward whose horizon runs past the last bootstrapped node is left blank';
  if (fwd3mGaps > 0) {
    ctx.unavailable.add({ field: 'nodes.fwd3m', reason: 'NO_SOURCE', detail: FWD_DETAIL });
  }
  if (fwd1yGaps > 0) {
    ctx.unavailable.add({ field: 'nodes.fwd1y', reason: 'NO_SOURCE', detail: FWD_DETAIL });
  }

  // ── compare ─────────────────────────────────────────────────────────────────────────────────
  const compare: CrvfCompare[] = [];
  for (const date of params.compare) {
    const other = await ctx.data.curves.points(params.curveId, date).catch(() => null);
    if (other === null || other.points.length === 0 || other.curveDate === points.curveDate) {
      ctx.unavailable.add({
        field: `compare.${date}`,
        reason: 'NO_SOURCE',
        detail: `no ${params.curveId} curve on or before ${date}`,
      });
      continue;
    }
    const otherCite = await citeMany(
      ctx,
      other.points.map((p) => p.provenanceId),
    );
    const otherBuild =
      other.kind === 'fixing'
        ? null
        : await ctx.data.curves
            .build(params.curveId, other.curveDate, interpolation)
            .catch(() => null);
    if (otherBuild !== null) ctx.engines.add(otherBuild.engine);
    const otherDate = other.curveDate;
    const otherFrequency = other.compounding === 'annual' || other.kind === 'ois' ? 1 : 2;
    const otherNodes: CrvfCompareNode[] = [];
    const otherTimes = otherBuild === null ? new Map<string, number>() : inputTimesOf(otherBuild);
    for (const tenor of gridTenors(params, other, otherDate)) {
      const t =
        otherTimes.get(tenor.tenor) ??
        timeOf(otherDate, addDaysIso(otherDate, tenor.days), other.dayCount, otherFrequency);
      if (otherBuild === null) {
        otherNodes.push({ tenor: tenor.tenor, t, par: null, zero: null, df: null });
        continue;
      }
      const nc: NodeContext = {
        curveDate: otherDate,
        dayCount: other.dayCount,
        compounding: other.compounding,
        kind: other.kind,
        frequency: otherFrequency,
        curve: otherBuild.curve,
        lastT: otherBuild.curve.times[otherBuild.curve.times.length - 1] ?? 0,
      };
      otherNodes.push({
        tenor: tenor.tenor,
        t,
        par: parRateOf(nc, tenor.tenor),
        zero: otherBuild.curve.zero(t) * 100,
        df: otherBuild.curve.df(t),
      });
    }
    const otherFirst = other.points[0]!;
    compare.push({
      date: other.curveDate,
      buildId: otherBuild?.buildId ?? null,
      provIdx: otherCite.get(otherFirst.provenanceId) ?? -1,
      nodes: otherNodes,
    });
  }

  // ── changes ─────────────────────────────────────────────────────────────────────────────────
  const changes: CrvfChange[] = nodes.map((node) => ({
    tenor: node.tenor,
    vsCompare: compare.map((entry) => {
      const other = entry.nodes.find((n) => n.tenor === node.tenor);
      return {
        date: entry.date,
        parBp:
          node.par === null || other?.par === undefined || other.par === null
            ? null
            : (node.par - other.par) * 100,
        zeroBp:
          node.zero === null || other?.zero === undefined || other.zero === null
            ? null
            : (node.zero - other.zero) * 100,
      };
    }),
  }));

  const buildBlock: CrvfBuildBlock = {
    buildId: build?.buildId ?? -1,
    method: build?.method ?? 'none',
    interpolation,
    engine: build?.engine ?? null,
    caveats,
    cached: build?.cached ?? false,
  };

  return {
    variant: 'default',
    curve: {
      id: points.curveId,
      name: points.name,
      currency: points.currency,
      kind: points.kind,
      dayCount: points.dayCount,
      compounding: points.compounding,
      sourceId: points.sourceId,
      provIdx: provIdxCurve,
      date: points.curveDate,
      requestedDate: params.date,
      availableDates: points.availableDates,
    },
    build: buildBlock,
    inputs,
    nodes,
    compare,
    changes,
    asOf: ctx.asOf.validAt.toISOString(),
  };
}

/** `addDays` on an ISO day, kept local so the node grid and the compare grid agree. */
function addDaysIso(date: IsoDate, days: number): IsoDate {
  const ms = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** Exported for the tests and the screen: the curve the build used, unchanged. */
export type { CurveBuild, CurvePoints };
