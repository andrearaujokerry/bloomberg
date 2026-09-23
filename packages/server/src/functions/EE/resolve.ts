/**
 * `functions/EE/resolve.ts` — Earnings (FUNCTIONS_TIER2.md §EE L159-272, WORKPLAN WP-10).
 *
 * EE is the clearest case in the package of "the terminal does not invent data". A Bloomberg
 * earnings screen is mostly estimates — consensus EPS, dispersion, surprise. This wedge has no
 * estimates provider (BRIEF §2), so `estimate` and `surprisePct` are `null` on every row, the
 * `consensus` block carries `NO_ESTIMATES_SOURCE`, and two `meta.unavailable` entries say so with
 * a detail string. Never blank-without-reason, never zero, never a fabricated number (NEWS-08).
 *
 * What the screen *does* measure, it measures from filings:
 *
 *  - **actuals** from `fin_statements`, point-in-time on `filed_at <= knownAt` (STOR-06). A
 *    restatement therefore changes the history when the "known at" date moves past it, exactly as
 *    it does on FA — the two screens read the same rows through the same service;
 *  - **report timing** from the 8-K item 2.02 acceptance instant, converted to Eastern Time:
 *    before 09:30 is `'pre'`, at or after 16:00 is `'post'`, in between is `'intraday'`. No such
 *    filing stored → `'unknown'` and `reportedAt: null`, never a guessed session;
 *  - **the next expected report** from the issuer's own cadence: the median gap between the last
 *    eight 10-Q/10-K filings. `next.basis` states the gap it used and `next.confidence` says how
 *    much of a measurement it is (0.6 from four or more gaps, 0.4 from the prior-year fallback).
 *    Fewer than two filings → `next: null`, because one date is not a cadence.
 */

import { sql } from 'drizzle-orm';

import { NO_ESTIMATES_DETAIL, NO_ESTIMATES_SOURCE } from '@terminal/core/functions/manifests/EE';
import type {
  EeHistoryRow,
  EeNextReport,
  EeParams,
  EePayload,
} from '@terminal/core/functions/manifests/EE';

import type { Filing } from '../../data/filings.js';
import type { FinStatement } from '../../data/fundamentals.js';
import type {
  FunctionResolver,
  FunctionServerModule,
  ReadThroughKind,
  ResolveContext,
} from '../context.js';

const DAY_MS = 86_400_000;
const SIX_HOURS_MS = 6 * 3_600_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared plumbing (the same three helpers FA states its reasons for)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function knownAtOf(ctx: ResolveContext, param: string | undefined): Date {
  if (param === undefined) return ctx.asOf.knownAt;
  const asked = new Date(param);
  if (Number.isNaN(asked.getTime())) return ctx.asOf.knownAt;
  return asked.getTime() < ctx.asOf.knownAt.getTime() ? asked : ctx.asOf.knownAt;
}

async function citeMany(
  ctx: ResolveContext,
  ids: readonly (number | null | undefined)[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const want: number[] = [];
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue;
    if (!want.includes(id)) want.push(id);
  }
  if (want.length === 0) return out;

  const list = sql.join(
    want.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<{
    provenance_id: string;
    source_id: string;
    captured_at: string;
    source_ts: string | null;
  }>(sql`
    SELECT provenance_id::text AS provenance_id, source_id,
           to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           to_char(source_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts
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

async function tryEnsure(
  ctx: ResolveContext,
  kind: ReadThroughKind,
  key: string,
  maxAgeMs: number,
): Promise<void> {
  if (ctx.usage === 'export') return;
  if (key.trim() === '') return;
  try {
    await ctx.providers.ensure(kind, key, { maxAgeMs });
  } catch {
    // Stored rows stay what they are; the block that wanted fresher data reports its own gap.
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Report timing (§EE step 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Eastern-Time hour and minute of an instant, without a timezone library.
 *
 * `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` is the only conversion in the
 * runtime that knows about the DST rule, and it is the one the rest of the server uses for venue
 * sessions. Reading the parts back out of `formatToParts` avoids parsing a localised string.
 */
function easternHourMinute(iso: string): { hour: number; minute: number } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // `hour12: false` renders midnight as 24 in some ICU versions.
  return { hour: hour === 24 ? 0 : hour, minute };
}

/** `< 09:30 ET → 'pre'`, `>= 16:00 ET → 'post'`, otherwise `'intraday'` (§EE step 3). */
export function reportTimingOf(acceptedAt: string | null): EeHistoryRow['reportTiming'] {
  if (acceptedAt === null) return 'unknown';
  const et = easternHourMinute(acceptedAt);
  if (et === null) return 'unknown';
  if (et.hour < 9 || (et.hour === 9 && et.minute < 30)) return 'pre';
  if (et.hour >= 16) return 'post';
  return 'intraday';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The next expected report (§EE step 4)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * A stored instant as ISO-8601.
 *
 * `filings.accepted_at` is read back as Postgres renders it (`'2026-07-30 20:31:00+00'`), and a
 * payload timestamp is ISO-8601 (FUNCTIONS.md §1.3 rule 3) — the client parses it, the golden pins
 * it, and the CSV prints it. Converted here rather than at the call site so both the payload and
 * the Eastern-Time conversion read the same value.
 */
function isoInstant(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
}

/**
 * The projection, from the filing dates of the last eight periodic reports (newest first).
 *
 * This is a measurement of the issuer's own cadence, not a schedule the issuer published: there is
 * no earnings-calendar provider in the wedge either. `method`, `basis` and `confidence` are in the
 * payload so the screen can say which it is.
 */
export function projectNextReport(filedDays: readonly string[]): EeNextReport | null {
  const days = [...new Set(filedDays)].sort().reverse().slice(0, 8);
  if (days.length < 2) return null;
  const lastDay = days[0];
  if (lastDay === undefined) return null;
  const lastMs = Date.parse(`${lastDay}T00:00:00Z`);

  const gaps: number[] = [];
  for (let i = 0; i + 1 < days.length; i++) {
    const newer = Date.parse(`${days[i] ?? ''}T00:00:00Z`);
    const older = Date.parse(`${days[i + 1] ?? ''}T00:00:00Z`);
    if (Number.isFinite(newer) && Number.isFinite(older)) gaps.push((newer - older) / DAY_MS);
  }

  const med = median(gaps);
  if (gaps.length >= 4 && med !== null) {
    const expectedMs = lastMs + med * DAY_MS;
    return {
      expectedDate: isoDay(expectedMs),
      window: [isoDay(expectedMs - 7 * DAY_MS), isoDay(expectedMs + 7 * DAY_MS)],
      method: 'cadence',
      basis: `median gap of last ${String(days.length)} 10-Q/10-K filings = ${String(Math.round(med))} d`,
      confidence: 0.6,
    };
  }

  // Fewer than four gaps: the same quarter one year earlier, plus a year. Weaker, and labelled so.
  const priorYear = days.find((d) => Date.parse(`${d}T00:00:00Z`) <= lastMs - 300 * DAY_MS);
  const baseMs = priorYear === undefined ? lastMs : Date.parse(`${priorYear}T00:00:00Z`);
  const expectedMs = baseMs + 365 * DAY_MS;
  return {
    expectedDate: isoDay(expectedMs),
    window: [isoDay(expectedMs - 7 * DAY_MS), isoDay(expectedMs + 7 * DAY_MS)],
    method: 'prior_year',
    basis:
      priorYear === undefined
        ? `fewer than four filing gaps; one year after the newest filing ${lastDay}`
        : `one year after the filing of the same period ${priorYear}`,
    confidence: 0.4,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Metric selection
// ─────────────────────────────────────────────────────────────────────────────────────────────

const METRIC_COLUMN: Readonly<Record<EeParams['metric'], keyof FinStatement>> = {
  EPS_DIL: 'epsDil',
  EPS_BASIC: 'epsBasic',
  REVENUE: 'revenue',
  NET_INC: 'netInc',
};

function actualOf(stmt: FinStatement, metric: EeParams['metric']): number | null {
  const value = stmt[METRIC_COLUMN[metric]];
  return typeof value === 'number' ? value : null;
}

const change = (now: number | null, then: number | null): number | null => {
  if (now === null || then === null || then === 0) return null;
  const v = now / then - 1;
  return Number.isFinite(v) ? v : null;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const resolve: FunctionResolver<EeParams, EePayload> = async (ctx, params) => {
  const instrumentRow = ctx.instrument;
  if (instrumentRow === null) {
    throw new Error('EE: requiresSecurity is true, so the runner must supply an instrument');
  }
  const knownAt = knownAtOf(ctx, params.knownAt);
  const detail = await ctx.data.reference.instrument(instrumentRow.instrumentId);
  const issuer = detail.issuer;
  const cik = issuer?.cik ?? null;
  const unit: EePayload['unit'] =
    params.metric === 'EPS_DIL' || params.metric === 'EPS_BASIC' ? 'per_share' : 'ccy';

  // The two standing gaps, on every run, whatever else the screen finds (§EE step 5). Each is
  // named twice on purpose: once as the dictionary field id §EE's reason codes are written in, and
  // once as the payload column a screen leaves blank, because rule 6 is checked per cell and a
  // reader hovering `estimate` should not have to know that `EE_EPS_ESTIMATE` is the same thing.
  for (const field of [
    'EE_EPS_ESTIMATE',
    'EE_SURPRISE_PCT',
    'history.estimate',
    'history.surprisePct',
  ]) {
    ctx.unavailable.add({ field, reason: 'NO_SOURCE', detail: NO_ESTIMATES_DETAIL });
  }

  const shell = (history: EeHistoryRow[], next: EeNextReport | null): EePayload => ({
    variant: 'equity',
    issuer: {
      issuerId: issuer?.issuerId ?? 0,
      name: issuer?.name ?? detail.instrument.name,
      cik: cik ?? '',
      fiscalYearEnd: issuer?.fiscalYearEnd ?? null,
    },
    metric: params.metric,
    unit,
    history,
    ttm: ttmOf(history),
    next,
    consensus: { value: null, reason: NO_ESTIMATES_SOURCE },
    // Oldest → newest: a sparkline reads left to right.
    sparkline: [...history]
      .reverse()
      .map((r) => ({ t: Date.parse(`${r.periodEnd}T00:00:00Z`), v: r.actual })),
    knownAt: knownAt.toISOString(),
  });

  if (cik === null || cik === '') {
    ctx.unavailable.add({
      field: 'history',
      reason: 'NO_SOURCE',
      detail: 'issuer has no SEC CIK',
    });
    return shell([], null);
  }

  const read = (): Promise<FinStatement[]> =>
    ctx.data.fundamentals.statementsForCik(cik, {
      statement: 'IS',
      periodType: 'Q',
      periods: params.periods,
      knownAt,
      at: ctx.asOf,
    });

  let quarters = await read();
  if (quarters.length === 0) {
    await tryEnsure(ctx, 'sec.companyfacts', cik, DAY_MS);
    quarters = await read();
  }
  if (quarters.length === 0) {
    ctx.unavailable.add({
      field: 'history',
      reason: 'NO_SOURCE',
      detail:
        'no quarterly fin_statements for CIK ' +
        cik +
        ' filed on or before ' +
        knownAt.toISOString().slice(0, 10),
    });
    return shell([], null);
  }

  // The filings the timing and the cadence come from. `oldest periodEnd` bounds the window so a
  // long history does not read the whole filer.
  const oldest = quarters[quarters.length - 1]?.periodEnd;
  await tryEnsure(ctx, 'sec.submissions', cik, SIX_HOURS_MS);
  const filings = await ctx.data.filings.list(cik, {
    forms: ['8-K', '8-K/A', '10-Q', '10-K'],
    ...(oldest === undefined ? {} : { from: oldest }),
    limit: 200,
  });

  const cite = await citeMany(ctx, [
    ...quarters.map((q) => q.provenanceIds[0]),
    ...filings.items.map((f) => f.provenanceId),
  ]);

  const byAccession = new Map(filings.items.map((f) => [f.accessionNo.trim(), f]));
  const earningsEightKs = filings.items.filter(
    (f) => f.form.startsWith('8-K') && f.items.includes('2.02'),
  );

  const history: EeHistoryRow[] = quarters.map((stmt, i) => {
    const actual = actualOf(stmt, params.metric);
    const prior = quarters[i + 1];
    const yearAgo = quarters.find(
      (q) =>
        q.fiscalPeriod === stmt.fiscalPeriod &&
        stmt.fiscalYear !== null &&
        q.fiscalYear === stmt.fiscalYear - 1,
    );
    const accession = stmt.accessionNo.trim();
    const filing = byAccession.get(accession);
    const release = firstReleaseFor(earningsEightKs, stmt.periodEnd);
    return {
      periodEnd: stmt.periodEnd,
      fiscalYear: stmt.fiscalYear,
      fiscalPeriod: stmt.fiscalPeriod,
      actual,
      yoyPct: yearAgo === undefined ? null : change(actual, actualOf(yearAgo, params.metric)),
      qoqPct: prior === undefined ? null : change(actual, actualOf(prior, params.metric)),
      filedAt: stmt.filedAt,
      accessionNo: accession,
      form: filing?.form ?? (stmt.fiscalPeriod === 'Q4' ? '10-K' : '10-Q'),
      url: filing?.url ?? '',
      reportTiming: reportTimingOf(isoInstant(release?.acceptedAt ?? null)),
      reportedAt: isoInstant(release?.acceptedAt ?? null),
      estimate: null,
      surprisePct: null,
      provIdx: cite.get(stmt.provenanceIds[0] ?? -1) ?? -1,
    };
  });

  // §EE step 2 sanctions a null growth rate on a period whose comparable is not in the window —
  // the four oldest quarters have no year-ago quarter and the oldest has no prior one. Sanctioned
  // is not the same as unexplained: rule 6 wants the screen to be able to say why the cell is
  // blank, so the column says it rather than the runner guessing.
  if (history.some((r) => r.yoyPct === null)) {
    ctx.unavailable.add({
      field: 'history.yoyPct',
      reason: 'NOT_APPLICABLE',
      detail:
        'a period whose year-ago quarter is not in the loaded window — or whose year-ago actual ' +
        'is absent or zero — has no year-on-year growth; it is never computed against a ' +
        'different fiscal period',
    });
  }
  if (history.some((r) => r.qoqPct === null)) {
    ctx.unavailable.add({
      field: 'history.qoqPct',
      reason: 'NOT_APPLICABLE',
      detail:
        'the oldest period in the window has no prior quarter to compare with — and a zero or ' +
        'absent prior actual has no percentage change',
    });
  }

  if (history.some((r) => r.reportTiming === 'unknown')) {
    ctx.unavailable.add({
      field: 'reportedAt',
      reason: 'NO_SOURCE',
      detail:
        'TIMING_UNKNOWN: no 8-K carrying item 2.02 is stored within 60 days of the period end, ' +
        'so the pre/post-market timing of that release is not known',
    });
  }

  const periodic = filings.items.filter((f) => f.form === '10-Q' || f.form === '10-K');
  const next = projectNextReport(periodic.map((f) => f.filedDate));

  return shell(history, next);
};

/**
 * The first 8-K with item 2.02 accepted in `(periodEnd, periodEnd + 60 d]` — the earnings release
 * of that quarter. Filings arrive newest first, so the *oldest* match inside the window is the
 * release rather than a later correction.
 */
function firstReleaseFor(eightKs: readonly Filing[], periodEnd: string): Filing | undefined {
  const endMs = Date.parse(`${periodEnd}T00:00:00Z`);
  const windowEnd = endMs + 60 * DAY_MS;
  let best: Filing | undefined;
  for (const f of eightKs) {
    const filedMs = Date.parse(`${f.filedDate}T00:00:00Z`);
    if (!Number.isFinite(filedMs) || filedMs <= endMs || filedMs > windowEnd) continue;
    if (best === undefined || filedMs < Date.parse(`${best.filedDate}T00:00:00Z`)) best = f;
  }
  return best;
}

/** The sum of the last four quarters, or `null` unless four consecutive quarters are present. */
function ttmOf(history: readonly EeHistoryRow[]): EePayload['ttm'] {
  const last4 = history.slice(0, 4);
  if (last4.length < 4 || last4.some((r) => r.actual === null)) {
    return { value: null, periodEnd: history[0]?.periodEnd ?? null };
  }
  return {
    value: last4.reduce((sum, r) => sum + (r.actual ?? 0), 0),
    periodEnd: last4[0]?.periodEnd ?? null,
  };
}

/** FUNC-02: one asset class, one variant — the map exists so the runner's assertion has a target. */
export const variants = { equity: resolve };

const module_: FunctionServerModule<EeParams, EePayload> = { resolve, variants };

export default module_;
