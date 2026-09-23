/**
 * `functions/GP/resolve.ts` — the price graph (FUNCTIONS_TIER1.md §GP L381-550).
 *
 * ## What the payload is
 *
 * Raw levels, in the security's own currency (or the one the caller asked for), with every bar's
 * source cited. Normalisation (`pct`, `base100`) and the studies are **client-side transforms of
 * exactly these numbers**, which is why they are not in the payload: the CSV is the source data,
 * and a reader who exports a chart gets what the chart was drawn from rather than a rendering of
 * it. A study recomputed in the client from the exported closes is reproducible; a study baked into
 * the payload is a number nobody can check.
 *
 * ## Seven variants, one shape
 *
 * `series.ts` turns seven different tables into one `GpSeries`, so this file only has to decide
 * *which window*, *which periodicity* and *what else belongs on the canvas* — overlays, event
 * markers, annotations and the live header cell. The variant is fixed by the asset class and is
 * asserted by the runner against the manifest (FUNC-02).
 *
 * ## The two things that degrade rather than fail
 *
 * An **overlay** that does not resolve is dropped with a `NOT_APPLICABLE` note and the chart still
 * draws the primary: a typo in `VS=` must not cost the user the line they came for. A **provider
 * circuit** that is open leaves the series at whatever is stored, and `meta.staleness` says so.
 * Neither is a 4xx, because neither makes the primary series wrong.
 */

import { and, eq, sql } from 'drizzle-orm';

import {
  parseFormula,
  evaluateFormulaNode,
  formatFormula,
  formulaDependencies,
  canonicalJson,
  sha256Hex,
} from '@terminal/core';
import type { FieldId, PayloadAdjustment, ValueCell } from '@terminal/core';
import type {
  GpAnnotation,
  GpParams,
  GpPayload,
  GpSeries,
  GpSeriesPeriodicity,
  GpVariant,
} from '@terminal/core/functions/manifests/GP';
import { addDays, addMonths, addYears } from '@terminal/core/calendars/calendar';
import type { FormulaNode, FormulaSecurity } from '@terminal/core';

import { chartAnnotations } from '../../db/schema/workspace.js';
import { provenance } from '../../db/schema/provenance.js';
import { optionTerms } from '../../db/schema/terms.js';
import { ValidationFailedError } from '../../http/errors.js';
import { cellFromState } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';
import { venueCalendar } from '../shared/returns.js';
import { buildEvents } from './events.js';
import { buildSeries, isIntraday } from './series.js';

import type { InstrumentDetail } from '../../data/reference.js';
import type { FunctionResolver, ResolveContext } from '../context.js';

/** The `SecurityRefInput` union as the payload spells it (`{id} | {ref} | {formula}`). */
type GpRef = GpSeries['ref'];

const FORMULA_ENGINE = { name: 'formula', version: '1.0.0' } as const;

/** Asset class → `payload.variant`, copied from the manifest so the runner's assert passes. */
const VARIANTS: Readonly<Record<string, GpVariant>> = {
  equity: 'equity',
  etf: 'equity',
  index: 'index',
  fx: 'fx',
  govt: 'govt',
  option: 'option',
  crypto: 'crypto',
  rate: 'series',
  econ: 'series',
};

export const resolve: FunctionResolver<GpParams, GpPayload> = async (ctx, params) => {
  const instrument = ctx.instrument;
  if (instrument === null) throw new Error('GP requires a security context.');

  const detail = await ctx.data.reference.instrument(instrument.instrumentId);
  const venue = await venueCalendar(ctx, detail);
  const variant = VARIANTS[instrument.assetClass] ?? 'equity';

  const plan = planWindow(ctx, params, detail);
  const key = displayOf(
    detail.instrument.ticker,
    detail.instrument.exchCode,
    detail.instrument.marketSector,
  );

  const primaryBuilt = await buildSeries({
    ctx,
    params,
    detail,
    ref: { id: detail.instrument.instrumentId },
    window: { start: plan.start, end: plan.end },
    periodicity: plan.periodicity,
    days: plan.days,
    calendarId: venue.calendarId ?? '',
    tz: 'UTC',
    field: 'primary',
  });

  const overlays = await buildOverlays(ctx, params, plan, venue.calendarId ?? '');

  const events = await buildEvents({
    ctx,
    params,
    detail,
    window: { start: plan.start, end: plan.end },
    variant,
    key,
  });

  const annotations = await loadAnnotations(ctx, detail.instrument.instrumentId);

  const subject = ctx.plant.subjectFor(detail.instrument.instrumentId);
  const state = ctx.plant.snapshot(subject);
  // §0.4 rule 2's exception: a single-security screen may `ensure` once when the subject is blank.
  if (state === undefined) ctx.plant.ensureHot([subject]);
  const last = cellFromState(ctx, state, 'PX_LAST', subject);
  if (last.v === null && last.r === undefined) {
    ctx.unavailable.add({
      field: 'last',
      reason: 'NO_SOURCE',
      detail: 'no quote recorded for this subject yet',
    });
  }

  const reference = await buildReference(ctx, detail, state, primaryBuilt.series, variant);

  const adjustments: PayloadAdjustment[] = primaryBuilt.adjustments;

  return {
    variant,
    primary: primaryBuilt.series,
    overlays: overlays.map((o) => o.series),
    events,
    annotations,
    window: {
      start: plan.start,
      end: plan.end,
      range: params.range,
      periodicity: plan.periodicity,
      bars: primaryBuilt.series.t.length,
    },
    last,
    reference,
    adjustments,
    // `data.historical.bars` applies the conversion and does not return the rates it used, so the
    // rate points are not available to repeat here. `primary.converted` still says a conversion
    // happened, and `meta.provenance` carries the `fx_rates` rows the reader cited.
    fx: [],
  };
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Window and periodicity (§GP step 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface WindowPlan {
  start: string;
  end: string;
  periodicity: GpSeriesPeriodicity;
  days: 1 | 2 | 5;
  /** True when an intraday periodicity was asked for over a range longer than 5D and was clamped. */
  clamped: boolean;
}

function planWindow(ctx: ResolveContext, params: GpParams, detail: InstrumentDetail): WindowPlan {
  const asOfDate = ctx.asOf.validAt.toISOString().slice(0, 10);
  const end = params.end ?? asOfDate;

  if (params.range === 'CUSTOM' && params.start === undefined) {
    throw new ValidationFailedError('fnParams', [
      { path: ['start'], message: "range 'CUSTOM' requires a start date" },
    ]);
  }

  const start =
    params.range === 'CUSTOM'
      ? (params.start ?? end)
      : startOf(params.range, end, detail.instrument.firstTradeDate);

  const requested = effectivePeriodicity(params, start, end);
  // §GP step 1: intraday is limited to 5D. A longer range falls back to daily rather than asking
  // the store for a year of minute bars, which would be a slow way to produce the same picture.
  const intradayAllowed = params.range === '1D' || params.range === '5D' || spanDays(start, end) <= 5;
  const clamped = isIntraday(requested) && !intradayAllowed;
  const periodicity: GpSeriesPeriodicity = clamped ? 'D' : requested;

  const days: 1 | 2 | 5 = params.range === '1D' ? 1 : 5;
  return { start, end, periodicity, days, clamped };
}

/** `auto`: 1D→1m, 5D→5m, ≤2Y→D, ≤10Y→W, MAX→M (§GP Params). */
function effectivePeriodicity(params: GpParams, start: string, end: string): GpSeriesPeriodicity {
  if (params.periodicity !== 'auto') return params.periodicity;
  if (params.range === '1D') return '1m';
  if (params.range === '5D') return '5m';
  if (params.range === 'MAX') return 'M';
  const span = spanDays(start, end);
  if (span <= 2 * 366) return 'D';
  if (span <= 10 * 366) return 'W';
  return 'M';
}

function spanDays(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

function startOf(range: GpParams['range'], end: string, firstTrade?: string): string {
  switch (range) {
    case '1D':
      return end;
    case '5D':
      return addDays(end, -7);
    case '1M':
      return addMonths(end, -1);
    case '3M':
      return addMonths(end, -3);
    case '6M':
      return addMonths(end, -6);
    case 'YTD':
      return `${end.slice(0, 4)}-01-01`;
    case '1Y':
      return addYears(end, -1);
    case '2Y':
      return addYears(end, -2);
    case '5Y':
      return addYears(end, -5);
    case '10Y':
      return addYears(end, -10);
    case 'MAX':
      return firstTrade ?? '1970-01-01';
    case 'CUSTOM':
      return end;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Overlays (§GP step 3, CHRT-03 / CHRT-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Overlay {
  series: GpSeries;
}

async function buildOverlays(
  ctx: ResolveContext,
  params: GpParams,
  plan: WindowPlan,
  calendarId: string,
): Promise<Overlay[]> {
  const out: Overlay[] = [];
  for (const [i, ref] of params.overlays.entries()) {
    const field = `overlays[${String(i)}]`;
    const overlay =
      'formula' in ref
        ? await formulaOverlay(ctx, params, plan, ref, field, calendarId)
        : await securityOverlay(ctx, params, plan, ref, field, calendarId);
    if (overlay !== null) out.push(overlay);
  }
  return out;
}

/**
 * One `VS=<security>` line.
 *
 * A reference that does not resolve — a typo, an ambiguity, a security outside the universe — is
 * dropped with the resolver's own message as the detail. Never a 4xx: the chart the user asked for
 * is the primary, and losing it because an overlay was misspelled is the wrong trade.
 */
async function securityOverlay(
  ctx: ResolveContext,
  params: GpParams,
  plan: WindowPlan,
  ref: Exclude<GpRef, { formula: string }>,
  field: string,
  calendarId: string,
): Promise<Overlay | null> {
  // `SecurityResolver` takes the command-line string or an id, never the wire's `{ ref }` wrapper.
  const item = await ctx.data.reference.resolve('id' in ref ? { id: ref.id } : ref.ref);

  if (item.instrument === null) {
    ctx.unavailable.add({
      field,
      reason: 'NOT_APPLICABLE',
      detail: item.error?.message ?? 'SECURITY_NOT_FOUND',
    });
    return null;
  }

  const detail = await ctx.data.reference.instrument(item.instrument.instrumentId);
  const venue = await venueCalendar(ctx, detail);
  const built = await buildSeries({
    ctx,
    params,
    detail,
    ref,
    window: { start: plan.start, end: plan.end },
    periodicity: plan.periodicity,
    days: plan.days,
    calendarId: venue.calendarId ?? calendarId,
    tz: 'UTC',
    field,
  });
  return { series: built.series };
}

/**
 * One `VS=<RATIO(A, B)>` line (CHRT-07).
 *
 * `core/formula`'s evaluator is scalar — it answers "what is this formula worth *now*" — so a
 * charted formula is that evaluation repeated once per date, over the **intersection** of its
 * leaves' dates. The intersection rather than a union with gaps: `RATIO(A, B)` on a day when only
 * A traded is not a ratio, and carrying B forward would invent a value for a market that was shut.
 *
 * The result is a close-only series: there is no such thing as the open of a ratio.
 */
async function formulaOverlay(
  ctx: ResolveContext,
  params: GpParams,
  plan: WindowPlan,
  ref: { formula: string },
  field: string,
  calendarId: string,
): Promise<Overlay | null> {
  const parsed = parseFormula(ref.formula);
  if (parsed.ast === null || parsed.problems.length > 0) {
    ctx.unavailable.add({
      field,
      reason: 'NOT_APPLICABLE',
      detail: `formula parse error: ${parsed.problems[0]?.message ?? 'unparseable'}`,
    });
    return null;
  }
  const node: FormulaNode = parsed.ast;

  const deps = formulaDependencies(node);
  const byCanonical = new Map<string, Map<number, number>>();
  let currency = 'USD';

  for (const leaf of deps.securities) {
    const item = await ctx.data.reference.resolve(leaf.text);
    if (item.instrument === null) {
      ctx.unavailable.add({
        field,
        reason: 'NOT_APPLICABLE',
        detail: item.error?.message ?? `SECURITY_NOT_FOUND ${leaf.text}`,
      });
      return null;
    }
    const detail = await ctx.data.reference.instrument(item.instrument.instrumentId);
    const venue = await venueCalendar(ctx, detail);
    const built = await buildSeries({
      ctx,
      params,
      detail,
      ref: { ref: leaf.text },
      window: { start: plan.start, end: plan.end },
      periodicity: plan.periodicity,
      days: plan.days,
      calendarId: venue.calendarId ?? calendarId,
      tz: 'UTC',
      field,
    });
    currency = built.series.currency;
    const points = new Map<number, number>();
    for (const [i, t] of built.series.t.entries()) {
      const close = built.series.c[i];
      if (close !== undefined && Number.isFinite(close)) points.set(t, close);
    }
    byCanonical.set(leaf.canonical, points);
  }

  // The intersection of every leaf's dates, ascending.
  const seriesList = [...byCanonical.values()];
  const first = seriesList[0];
  const dates =
    first === undefined
      ? []
      : [...first.keys()].filter((t) => seriesList.every((s) => s.has(t))).sort((a, b) => a - b);

  const t: number[] = [];
  const c: number[] = [];
  for (const at of dates) {
    const evaluation = evaluateFormulaNode(node, {
      field: (security: FormulaSecurity | null) =>
        security === null ? null : (byCanonical.get(security.canonical)?.get(at) ?? null),
    });
    if (evaluation.value === null) continue;
    t.push(at);
    c.push(evaluation.value);
  }

  ctx.engines.add({
    ...FORMULA_ENGINE,
    inputsHash: sha256Hex(canonicalJson({ formula: formatFormula(node), dates })),
  });

  if (t.length === 0) {
    ctx.unavailable.add({ field, reason: 'NO_SOURCE', detail: 'no bars in window' });
  }

  return {
    series: {
      ref,
      instrument: null,
      formula: formatFormula(node),
      key: ref.formula,
      label: ref.formula,
      currency,
      calendarId,
      tz: 'UTC',
      unit: 'pct',
      t,
      o: null,
      h: null,
      l: null,
      c,
      v: null,
      adjust: params.adjust,
      periodicity: plan.periodicity,
      sessions: null,
      converted: null,
      // A computed series has no capture of its own; its inputs are cited by their own blocks and
      // the `formula@1.0.0` engine entry is what a reader follows to reproduce it (ANAL-08).
      provIdx: -1,
      live: null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Annotations (CHRT-05) and the reference lines
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The user's drawings on this security, under RLS: own, firm-shared and shared-with-me, which the
 * `chart_annotations` policies decide — the resolver asks for the instrument and reads what it is
 * allowed to see, rather than repeating the policy in a `WHERE` clause that could disagree with it.
 */
async function loadAnnotations(ctx: ResolveContext, instrumentId: number): Promise<GpAnnotation[]> {
  const rows = await ctx.db
    .select({
      annotationId: chartAnnotations.annotationId,
      ownerUserId: chartAnnotations.ownerUserId,
      kind: chartAnnotations.kind,
      anchors: chartAnnotations.anchors,
      style: chartAnnotations.style,
      label: chartAnnotations.label,
      sharedScope: chartAnnotations.sharedScope,
    })
    .from(chartAnnotations)
    .where(eq(chartAnnotations.instrumentId, instrumentId))
    .orderBy(chartAnnotations.annotationId);

  return rows.map((row) => ({
    annotationId: row.annotationId,
    kind: row.kind as GpAnnotation['kind'],
    anchors: (row.anchors as { t: number; v: number }[]) ?? [],
    label: row.label,
    style: (row.style as Record<string, unknown>) ?? {},
    ownerUserId: row.ownerUserId,
    sharedScope: row.sharedScope as GpAnnotation['sharedScope'],
    editable: row.ownerUserId === ctx.user.userId,
  }));
}

/**
 * Prev close for a price chart, the last yield for a curve, the strike for a contract.
 *
 * Every line cites the block it came from: the strike cites the `option_terms` read, the yield
 * cites the series it is the last point of, the prev close cites the plant cell that already
 * carries the idx. A reference line is a price on a chart and §1.5 admits no price without one.
 */
async function buildReference(
  ctx: ResolveContext,
  detail: InstrumentDetail,
  state: Parameters<typeof cellFromState>[1],
  primary: GpSeries,
  variant: GpVariant,
): Promise<GpPayload['reference']> {
  if (variant === 'option') {
    const rows = await ctx.db
      .select({
        strike: optionTerms.strike,
        provenanceId: optionTerms.provenanceId,
        sourceId: provenance.sourceId,
        capturedAt: provenance.capturedAt,
        sourceTs: provenance.sourceTs,
      })
      .from(optionTerms)
      .innerJoin(provenance, eq(provenance.provenanceId, optionTerms.provenanceId))
      .where(
        and(
          eq(optionTerms.instrumentId, detail.instrument.instrumentId),
          sql`${optionTerms.txTo} = 'infinity'`,
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return [];
    const provIdx = ctx.prov.add({
      sourceId: row.sourceId,
      provenanceId: row.provenanceId,
      capturedAt: new Date(row.capturedAt),
      sourceTs: row.sourceTs === null ? null : new Date(row.sourceTs),
      st: 'closed',
      tier: 'eod',
    });
    return [{ label: 'strike', v: Number(row.strike), provIdx }];
  }

  if (variant === 'govt') {
    // The last point of the instrument's own yield series — not a par yield, which would have to
    // be bootstrapped from the curve. It cites the series it is a point of.
    const lastYield = primary.c.at(-1);
    return lastYield === undefined
      ? []
      : [{ label: 'last yield', v: lastYield, provIdx: primary.provIdx }];
  }

  if (variant === 'series') return [];

  const field: FieldId = 'PX_CLOSE_1D';
  const cell: ValueCell =
    state === undefined
      ? { v: null, st: 'blank', provIdx: -1 }
      : cellFromState(ctx, state, field, ctx.plant.subjectFor(detail.instrument.instrumentId));
  return typeof cell.v === 'number' && cell.provIdx >= 0
    ? [{ label: 'prev close', v: cell.v, provIdx: cell.provIdx }]
    : [];
}
