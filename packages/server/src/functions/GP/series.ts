/**
 * `functions/GP/series.ts` — one `GpSeries` per security, per variant (§GP resolver step 2).
 *
 * Seven variants exist because seven different tables answer "what was this worth over time", and
 * the differences are not cosmetic:
 *
 *  - **equity / etf / index / fx** — `bars_daily` through `data.historical.bars`, which applies
 *    the adjustment policy and the currency conversion on read (REF-09), or `bars_intraday`
 *    through `data.intraday.bars` for `1m`/`5m`.
 *  - **crypto** — there are no daily crypto bars in v1. The series is resampled from the captured
 *    `quote_ticks` polls, which are retained for thirty days, so anything longer than a month is
 *    context only and says so rather than drawing a line that stops.
 *  - **option** — `option_quotes` captures, `last` when the contract traded and the mid otherwise.
 *    Retained ten days.
 *  - **govt** — a Treasury has no price history worth charting; what moves is the *yield* of its
 *    tenor, which lives in `curve_points`. A CUSIP with no `term_label` is off the run and has no
 *    series at all.
 *  - **series** — `rate_fixings` for a rate, `econ_observations` at `vintage_at ≤ knownAt` for an
 *    economic release, because a revision is a new vintage and a chart drawn as of last month must
 *    show last month's numbers (STOR-06).
 *
 * Every builder returns the same `GpSeries`, so `resolve.ts` treats the primary and the overlays
 * identically and the canvas never asks where a line came from. Every builder also cites what it
 * read and records a reason when it read nothing: an empty chart with no explanation is the one
 * outcome this file will not produce.
 */

import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import type {
  GpParams,
  GpSeries,
  GpSeriesPeriodicity,
  GpUnit,
} from '@terminal/core/functions/manifests/GP';
import type { AssetClass, PayloadAdjustment } from '@terminal/core';

import { curvePoints } from '../../db/schema/curves.js';
import { optionQuotes } from '../../db/schema/timeseries.js';
import { govtTerms } from '../../db/schema/terms.js';
import type { InstrumentDetail } from '../../data/reference.js';
import { citeProvenance } from '../../data/reference.js';
import { toSummary } from '../shared/instrumentSummary.js';
import { displayOf } from '../shared/instrumentSummary.js';

import type { ResolveContext } from '../context.js';

/** How long the two capture-backed sources are kept (PROVIDERS retention, §GP step 2). */
export const TICK_RETENTION_DAYS = 30;
export const OPTION_RETENTION_DAYS = 10;

/** `data.ticks.last(id, n)` page size §GP names for the crypto resample. */
const TICK_PAGE = 45_000;

export interface SeriesRequest {
  ctx: ResolveContext;
  params: GpParams;
  detail: InstrumentDetail;
  ref: GpSeries['ref'];
  /** The window the chart draws, `YYYY-MM-DD` inclusive. */
  window: { start: string; end: string };
  /** The effective periodicity, after `auto` and the intraday clamp. */
  periodicity: GpSeriesPeriodicity;
  /** `1`, `2` or `5` — only consulted for an intraday periodicity. */
  days: 1 | 2 | 5;
  calendarId: string;
  tz: string;
  /** `'primary'` or `'overlays[<i>]'` — what an `unavailable` entry names. */
  field: string;
}

export interface BuiltSeries {
  series: GpSeries;
  /** REF-09 factor steps; `meta.adjustments` and the payload's own copy. */
  adjustments: PayloadAdjustment[];
}

/** Asset classes charted as a price line with a live quote behind them. */
const PRICE_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>([
  'equity',
  'etf',
  'index',
  'fx',
  'crypto',
  'option',
]);

export function isIntraday(periodicity: GpSeriesPeriodicity): periodicity is '1m' | '5m' {
  return periodicity === '1m' || periodicity === '5m';
}

/** The y-axis hint each family carries; what the series *is*, not how it is drawn. */
export function unitOf(assetClass: AssetClass, econUnits?: string): GpUnit {
  if (assetClass === 'index') return 'index';
  if (assetClass === 'govt') return 'yield';
  if (assetClass === 'rate') return 'rate';
  if (assetClass === 'econ') return econUnits?.startsWith('Percent') === true ? 'pct' : 'index';
  return 'price';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function buildSeries(input: SeriesRequest): Promise<BuiltSeries> {
  const assetClass = input.detail.instrument.assetClass;
  if (assetClass === 'govt') return govtSeries(input);
  if (assetClass === 'rate') return rateSeries(input);
  if (assetClass === 'econ') return econSeries(input);
  if (assetClass === 'option') return optionSeries(input);
  if (assetClass === 'crypto') return cryptoSeries(input);
  return isIntraday(input.periodicity) ? intradaySeries(input) : dailySeries(input);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// equity / etf / index / fx
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function dailySeries(input: SeriesRequest): Promise<BuiltSeries> {
  const { ctx, params, detail } = input;
  const id = detail.instrument.instrumentId;

  const block = await ctx.data.historical.bars(id, {
    start: input.window.start,
    end: input.window.end,
    // `'1m'`/`'5m'` never reach here; `'D' | 'W' | 'M'` is exactly what the reader resamples to.
    periodicity: input.periodicity as 'D' | 'W' | 'M',
    adjust: params.adjust,
    ...(params.currency === undefined ? {} : { currency: params.currency }),
    fields: ['PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME'],
  });

  const at = (id2: string): number => block.columns.indexOf(id2);
  const oAt = at('PX_OPEN');
  const hAt = at('PX_HIGH');
  const lAt = at('PX_LOW');
  const cAt = at('PX_LAST');
  const vAt = at('PX_VOLUME');

  const t: number[] = [];
  const o: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  const v: number[] = [];
  for (const [i, date] of block.index.entries()) {
    const row = block.rows[i] ?? [];
    const close = cell(row, cAt);
    if (close === null) continue;
    t.push(Date.parse(`${date}T00:00:00.000Z`));
    o.push(cell(row, oAt) ?? Number.NaN);
    h.push(cell(row, hAt) ?? Number.NaN);
    l.push(cell(row, lAt) ?? Number.NaN);
    c.push(close);
    v.push(cell(row, vAt) ?? Number.NaN);
  }

  noBars(input, t.length);

  const quoteCurrency = detail.instrument.currency;
  const converted =
    params.currency !== undefined && params.currency !== quoteCurrency
      ? { from: quoteCurrency, to: params.currency }
      : null;
  if (converted !== null && t.length === 0) {
    ctx.unavailable.add({
      field: 'fx',
      reason: 'NO_SOURCE',
      detail: `no ECB rate for ${converted.to}`,
    });
  }

  return {
    series: {
      ...skeleton(input),
      currency: block.currency,
      unit: unitOf(detail.instrument.assetClass),
      t,
      o: allNaN(o) ? null : o,
      h: allNaN(h) ? null : h,
      l: allNaN(l) ? null : l,
      c,
      v: allNaN(v) ? null : v,
      adjust: params.adjust,
      sessions: null,
      converted,
      provIdx: (await citeBlock(ctx, block.rowProvenanceIds))[0] ?? -1,
      live: liveOf(input),
    },
    adjustments: block.adjustments,
  };
}

async function intradaySeries(input: SeriesRequest): Promise<BuiltSeries> {
  const { ctx, detail } = input;
  const block = await ctx.data.intraday.bars(detail.instrument.instrumentId, {
    days: input.days,
    interval: input.periodicity === '5m' ? '5m' : '1m',
    session: 'regular',
  });

  const at = (id: string): number => block.columns.indexOf(id);
  const cAt = at('PX_LAST');
  const t: number[] = [];
  const o: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  const v: number[] = [];
  for (const [i, ts] of block.index.entries()) {
    const row = block.rows[i] ?? [];
    const close = cell(row, cAt);
    if (close === null) continue;
    t.push(Date.parse(ts));
    o.push(cell(row, at('PX_OPEN')) ?? close);
    h.push(cell(row, at('PX_HIGH')) ?? close);
    l.push(cell(row, at('PX_LOW')) ?? close);
    c.push(close);
    v.push(cell(row, at('PX_VOLUME')) ?? Number.NaN);
  }

  noBars(input, t.length);

  return {
    series: {
      ...skeleton(input),
      currency: block.currency,
      unit: unitOf(detail.instrument.assetClass),
      t,
      o,
      h,
      l,
      c,
      v: allNaN(v) ? null : v,
      adjust: input.params.adjust,
      sessions: block.sessions.map((band) => ({
        start: Date.parse(band.start),
        end: Date.parse(band.end),
        kind: band.kind,
      })),
      converted: null,
      provIdx: (await citeBlock(ctx, block.rowProvenanceIds))[0] ?? -1,
      live: liveOf(input),
    },
    adjustments: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// crypto — captured polls, resampled
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `bars_daily` carries no crypto rows in v1, so the chart is built from what was actually polled.
 *
 * That is thirty days of sixty-second CoinGecko captures and no more, which is stated on the
 * payload rather than implied by a line that simply ends: a user asking for `BTC 5Y` and getting a
 * month of data without being told has been misled about the market, not about the product.
 */
async function cryptoSeries(input: SeriesRequest): Promise<BuiltSeries> {
  const { ctx, detail } = input;
  const ticks = await ctx.data.ticks.last(detail.instrument.instrumentId, TICK_PAGE);

  const bucketMs = bucketSize(input.periodicity);
  const from = Date.parse(`${input.window.start}T00:00:00.000Z`);
  const to = Date.parse(`${input.window.end}T23:59:59.999Z`);

  const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
  let provIdx = -1;
  for (const tick of ticks) {
    const ts = Date.parse(tick.capTs);
    if (ts < from || ts > to) continue;
    const price = numberOf(tick.f.PX_LAST);
    if (price === null) continue;
    provIdx = provIdx < 0 ? tick.provIdx : provIdx;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    const volume = numberOf(tick.f.PX_VOLUME) ?? 0;
    if (bucket === undefined) {
      buckets.set(key, { o: price, h: price, l: price, c: price, v: volume });
    } else {
      bucket.h = Math.max(bucket.h, price);
      bucket.l = Math.min(bucket.l, price);
      bucket.c = price;
      bucket.v = volume;
    }
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const series = {
    ...skeleton(input),
    currency: detail.instrument.currency,
    unit: 'price' as const,
    t: keys,
    o: keys.map((k) => buckets.get(k)!.o),
    h: keys.map((k) => buckets.get(k)!.h),
    l: keys.map((k) => buckets.get(k)!.l),
    c: keys.map((k) => buckets.get(k)!.c),
    v: keys.map((k) => buckets.get(k)!.v),
    adjust: input.params.adjust,
    sessions: null,
    converted: null,
    provIdx,
    live: liveOf(input),
  };

  const spanDays = (to - from) / 86_400_000;
  if (spanDays > TICK_RETENTION_DAYS) {
    ctx.unavailable.add({
      field: input.field,
      reason: 'NO_SOURCE',
      detail:
        'no daily history source for crypto (context only); showing captured ticks (≤ 30 d)',
    });
  }
  noBars(input, keys.length);

  return { series, adjustments: [] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// option — capture history
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The contract's own captures: the traded `last` when there is one, the bid/ask mid otherwise.
 *
 * `data.options` has `chain()` and `terms()` and no history reader, so this goes through `ctx.db`
 * — the request transaction, which §1.4.1 grants a resolver for exactly this (§HP/series.ts reads
 * `curve_points` the same way). Reported as a deviation rather than papered over.
 */
async function optionSeries(input: SeriesRequest): Promise<BuiltSeries> {
  const { ctx, detail } = input;
  const bucketMs = bucketSize(input.periodicity);

  const rows = await ctx.db
    .select({
      captureTs: optionQuotes.captureTs,
      bid: optionQuotes.bid,
      ask: optionQuotes.ask,
      last: optionQuotes.last,
      volume: optionQuotes.volume,
      provenanceId: optionQuotes.provenanceId,
    })
    .from(optionQuotes)
    .where(
      and(
        eq(optionQuotes.instrumentId, detail.instrument.instrumentId),
        gte(optionQuotes.captureTs, `${input.window.start}T00:00:00.000Z`),
        lte(optionQuotes.captureTs, `${input.window.end}T23:59:59.999Z`),
      ),
    )
    .orderBy(asc(optionQuotes.captureTs));

  const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
  let provIdx = -1;
  for (const row of rows) {
    const price = optionPrice(row);
    if (price === null) continue;
    const ts = Date.parse(row.captureTs);
    provIdx =
      provIdx < 0
        ? ctx.prov.add({
            sourceId: 'cboe.options',
            provenanceId: row.provenanceId,
            capturedAt: new Date(ts),
            sourceTs: null,
            st: 'closed',
            tier: 'delayed',
          })
        : provIdx;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    const volume = row.volume ?? 0;
    if (bucket === undefined) buckets.set(key, { o: price, h: price, l: price, c: price, v: volume });
    else {
      bucket.h = Math.max(bucket.h, price);
      bucket.l = Math.min(bucket.l, price);
      bucket.c = price;
      bucket.v = volume;
    }
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const spanDays =
    (Date.parse(`${input.window.end}T00:00:00Z`) - Date.parse(`${input.window.start}T00:00:00Z`)) /
    86_400_000;
  if (spanDays > OPTION_RETENTION_DAYS) {
    ctx.unavailable.add({
      field: input.field,
      reason: 'NO_SOURCE',
      detail: 'option quotes retained 10 days',
    });
  }
  noBars(input, keys.length);

  return {
    series: {
      ...skeleton(input),
      currency: detail.instrument.currency,
      unit: 'price',
      t: keys,
      o: keys.map((k) => buckets.get(k)!.o),
      h: keys.map((k) => buckets.get(k)!.h),
      l: keys.map((k) => buckets.get(k)!.l),
      c: keys.map((k) => buckets.get(k)!.c),
      v: keys.map((k) => buckets.get(k)!.v),
      adjust: input.params.adjust,
      sessions: null,
      converted: null,
      provIdx,
      live: liveOf(input),
    },
    adjustments: [],
  };
}

function optionPrice(row: {
  bid: string | null;
  ask: string | null;
  last: string | null;
}): number | null {
  const last = row.last === null ? null : Number(row.last);
  if (last !== null && Number.isFinite(last)) return last;
  const bid = row.bid === null ? null : Number(row.bid);
  const ask = row.ask === null ? null : Number(row.ask);
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return (bid + ask) / 2;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// govt — the tenor's yield
// ─────────────────────────────────────────────────────────────────────────────────────────────

const BILL_TENOR = /^\d+WK$/;

async function govtSeries(input: SeriesRequest): Promise<BuiltSeries> {
  const { ctx, detail } = input;

  const terms = await ctx.db
    .select({ termLabel: govtTerms.termLabel })
    .from(govtTerms)
    .where(eq(govtTerms.instrumentId, detail.instrument.instrumentId))
    .orderBy(sql`${govtTerms.versionId} DESC`)
    .limit(1);

  const tenor = terms[0]?.termLabel ?? null;
  if (tenor === null || tenor.trim() === '') {
    ctx.unavailable.add({
      field: input.field,
      reason: 'NO_SOURCE',
      detail: 'no price history for off-the-run Treasuries',
    });
    return { series: emptySeries(input, 'yield'), adjustments: [] };
  }

  const isBill = BILL_TENOR.test(tenor);
  const curveId = isBill ? 'UST_BILL' : 'UST_PAR';
  const quoteType = isBill ? 'investment_yield' : 'par_yield';
  const sourceId = isBill ? 'treasury.bills' : 'treasury.yieldcurve';

  const rows = await ctx.db
    .select({
      curveDate: curvePoints.curveDate,
      value: curvePoints.value,
      vintageAt: curvePoints.vintageAt,
      provenanceId: curvePoints.provenanceId,
    })
    .from(curvePoints)
    .where(
      and(
        eq(curvePoints.curveId, curveId),
        eq(curvePoints.tenor, tenor),
        eq(curvePoints.quoteType, quoteType),
        gte(curvePoints.curveDate, input.window.start),
        lte(curvePoints.curveDate, input.window.end),
        lte(curvePoints.vintageAt, ctx.asOf.knownAt),
      ),
    )
    .orderBy(asc(curvePoints.curveDate), asc(curvePoints.vintageAt));

  const byDate = new Map<string, { v: number; provenanceId: number; vintageAt: Date }>();
  for (const row of rows) {
    byDate.set(row.curveDate, {
      v: Number(row.value),
      provenanceId: row.provenanceId,
      vintageAt: row.vintageAt,
    });
  }

  const dates = [...byDate.keys()].sort();
  let provIdx = -1;
  for (const date of dates) {
    const point = byDate.get(date)!;
    const idx = ctx.prov.add({
      sourceId,
      provenanceId: point.provenanceId,
      capturedAt: point.vintageAt,
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    if (provIdx < 0) provIdx = idx;
  }

  noBars(input, dates.length);

  return {
    series: {
      ...skeleton(input),
      currency: detail.instrument.currency,
      unit: 'yield',
      t: dates.map((d) => Date.parse(`${d}T00:00:00.000Z`)),
      o: null,
      h: null,
      l: null,
      c: dates.map((d) => byDate.get(d)!.v),
      v: null,
      adjust: input.params.adjust,
      sessions: null,
      converted: null,
      provIdx,
      live: null,
    },
    adjustments: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// series — rate and econ
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function rateSeries(input: SeriesRequest): Promise<BuiltSeries> {
  const { ctx, detail } = input;
  const code = detail.instrument.ticker;
  const span = Math.max(
    1,
    Math.ceil(
      (Date.parse(`${input.window.end}T00:00:00Z`) -
        Date.parse(`${input.window.start}T00:00:00Z`)) /
        86_400_000,
    ) + 1,
  );
  const fixings = await ctx.data.rates.history(code, span);

  const t: number[] = [];
  const c: number[] = [];
  let provIdx = -1;
  for (const fixing of fixings) {
    if (fixing.effectiveDate < input.window.start || fixing.effectiveDate > input.window.end) {
      continue;
    }
    if (Date.parse(fixing.vintageAt) > ctx.asOf.knownAt.getTime()) continue;
    if (fixing.rate === null) continue;
    const idx = ctx.prov.add({
      sourceId: 'nyfed.rates',
      provenanceId: fixing.provenanceId,
      capturedAt: new Date(fixing.capturedAt),
      sourceTs: fixing.sourceTs === null ? null : new Date(fixing.sourceTs),
      st: 'closed',
      tier: 'eod',
    });
    if (provIdx < 0) provIdx = idx;
    t.push(Date.parse(`${fixing.effectiveDate}T00:00:00.000Z`));
    c.push(fixing.rate);
  }

  noBars(input, t.length);

  return {
    series: {
      ...skeleton(input),
      currency: detail.instrument.currency,
      unit: 'rate',
      t,
      o: null,
      h: null,
      l: null,
      c,
      v: null,
      adjust: input.params.adjust,
      sessions: null,
      converted: null,
      provIdx,
      live: null,
    },
    adjustments: [],
  };
}

async function econSeries(input: SeriesRequest): Promise<BuiltSeries> {
  const { ctx, detail } = input;
  const meta =
    (await ctx.data.econ.seriesForInstrument(detail.instrument.instrumentId)) ??
    (await ctx.data.econ.series(detail.instrument.ticker));

  if (meta === null) {
    ctx.unavailable.add({
      field: input.field,
      reason: 'NO_SOURCE',
      detail: `no econ_series row for ${detail.instrument.ticker}`,
    });
    return { series: emptySeries(input, 'index'), adjustments: [] };
  }

  const obs = await ctx.data.econ.observations(meta.seriesCode, {
    from: input.window.start,
    to: input.window.end,
    knownAt: ctx.asOf.knownAt,
  });

  const t: number[] = [];
  const c: number[] = [];
  let provIdx = -1;
  for (const point of obs) {
    if (point.value === null) continue;
    const idx = ctx.prov.add({
      sourceId: meta.sourceId,
      provenanceId: point.provenanceId,
      capturedAt: new Date(point.vintageAt),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    if (provIdx < 0) provIdx = idx;
    t.push(Date.parse(`${point.obsDate}T00:00:00.000Z`));
    c.push(point.value);
  }

  noBars(input, t.length);

  return {
    series: {
      ...skeleton(input),
      currency: detail.instrument.currency,
      unit: unitOf('econ', meta.units),
      t,
      o: null,
      h: null,
      l: null,
      c,
      v: null,
      adjust: input.params.adjust,
      sessions: null,
      converted: null,
      provIdx,
      live: null,
    },
    adjustments: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared shaping
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Everything a series carries that does not depend on which table answered. */
function skeleton(
  input: SeriesRequest,
): Omit<
  GpSeries,
  | 'currency'
  | 'unit'
  | 't'
  | 'o'
  | 'h'
  | 'l'
  | 'c'
  | 'v'
  | 'adjust'
  | 'sessions'
  | 'converted'
  | 'provIdx'
  | 'live'
> {
  const i = input.detail.instrument;
  return {
    ref: input.ref,
    instrument: toSummary(input.detail),
    formula: null,
    key: displayOf(i.ticker, i.exchCode, i.marketSector),
    label: i.name,
    calendarId: input.calendarId,
    tz: input.tz,
    periodicity: input.periodicity,
  };
}

function emptySeries(input: SeriesRequest, unit: GpUnit): GpSeries {
  return {
    ...skeleton(input),
    currency: input.detail.instrument.currency,
    unit,
    t: [],
    o: null,
    h: null,
    l: null,
    c: [],
    v: null,
    adjust: input.params.adjust,
    sessions: null,
    converted: null,
    provIdx: -1,
    live: null,
  };
}

/**
 * §GP: the primary and each overlay instrument follow `q:<id>` on a daily chart and `b1m:<id>` on
 * an intraday one; a curve, a fixing and an economic release follow nothing, because nothing on
 * the wire updates them inside a session.
 */
function liveOf(input: SeriesRequest): GpSeries['live'] {
  const assetClass = input.detail.instrument.assetClass;
  if (!PRICE_CLASSES.has(assetClass)) return null;
  const id = input.detail.instrument.instrumentId;
  return isIntraday(input.periodicity)
    ? { subject: input.ctx.plant.subjectFor(id, 'b1m'), field: 'PX_LAST', mode: 'append-forming-bar' }
    : { subject: input.ctx.plant.subjectFor(id), field: 'PX_LAST', mode: 'replace-last' };
}

/** §GP's `no bars in window`: the chart renders the empty frame, never a flat line. */
function noBars(input: SeriesRequest, count: number): void {
  if (count > 0) return;
  input.ctx.unavailable.add({
    field: input.field,
    reason: 'NO_SOURCE',
    detail: 'no bars in window',
  });
}


/**
 * Re-cite a data-service block's rows into `ctx.prov`.
 *
 * `buildDataServices` is handed its **own** `ProvenanceIndex` (`http/routes/functions.ts`), while
 * `meta.provenance` is built from `ctx.prov` — two collectors, two numbering schemes. A `provIdx`
 * taken straight off a `SeriesBlock` therefore indexes an array the client never receives, and
 * `Ctrl+I` on a cell would open the wrong row or none at all. Citing the block's
 * `rowProvenanceIds` through `ctx.prov` costs one `SELECT` and makes the payload's indexes mean
 * what DATA-10 says they mean. Reported to the integrator: the underlying split is WP-08's wiring,
 * not this resolver's.
 */
async function citeBlock(ctx: ResolveContext, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const citation = await citeProvenance(ctx.db, ctx.prov, [...new Set(ids)], { st: 'closed' });
  return citation.provIdx;
}

export function bucketSize(periodicity: GpSeriesPeriodicity): number {
  switch (periodicity) {
    case '1m':
      return 60_000;
    case '5m':
      return 300_000;
    case 'D':
      return 86_400_000;
    case 'W':
      return 7 * 86_400_000;
    case 'M':
      return 30 * 86_400_000;
  }
}

function cell(row: readonly (number | null)[], at: number): number | null {
  return at < 0 ? null : (row[at] ?? null);
}

function allNaN(values: readonly number[]): boolean {
  return values.every((v) => Number.isNaN(v));
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
