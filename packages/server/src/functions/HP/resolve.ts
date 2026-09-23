/**
 * `functions/HP/resolve.ts` — HP's two variants (FUNCTIONS_TIER1.md §HP L658-770).
 *
 * ## What this function is actually about
 *
 * `bars_daily` holds the print as published and nothing else (DATA_MODEL §7.2). Everything a user
 * asks HP for — a weekly roll-up, a split-adjusted close, a total-return series, the same table in
 * euros — is computed **on read**, from that one unadjusted truth plus `corporate_actions` as of
 * `ctx.asOf`. WP-04's `data.historical.bars` does that work; this resolver's job is to choose the
 * window, ask for the right columns, compute the two fields the bar reader cannot (`CHG_NET_1D`
 * and `CHG_PCT_1D`, which are differences *between rows of the chosen periodicity*), summarise the
 * window, and page it.
 *
 * The consequence worth stating, because it looks like a bug the first time it is seen: the same
 * request at two `knownAt` instants returns two different price series. AAPL's 4:1 split was
 * *recorded* on 2020-07-31; a read as of 30 July 2020 sees no split and returns 499.23 for
 * 2020-08-28, and a read today sees it and returns 124.8075 (API.md §12.1 L1445-1447, REF-03 +
 * REF-09). Neither is wrong, and `meta.adjustments` says which world the numbers come from.
 *
 * ## Columns
 *
 * `params.fields` is a mixed list: six of the ten are bar fields the service can serve, and
 * `CHG_NET_1D` / `CHG_PCT_1D` are not — asking the service for them raises `RangeError`. They are
 * computed here against the previous row of the *resampled* series (so `CHG_PCT_1D` on a weekly
 * table is the week-on-week change, not the last day's), which is why the `stats@1.0.0` engine is
 * recorded whenever either is requested.
 *
 * ## Paging and the CSV
 *
 * `rows` is one page, and `toCsv` is handed the payload — so the export is the page, cell for
 * cell. §HP's CSV section says "the whole window"; the payload the export path receives holds only
 * what the payload holds, and duplicating up to 2 520 rows into every HP response to make that
 * sentence true would cost every screen for the benefit of one. FUNC-03 ("the CSV equals the
 * screen") is what this file honours, and the divergence is recorded for the integrator.
 */

import { cumulativeFactors } from '@terminal/core/adjust/corporateActions';
import type {
  HpColumn,
  HpParams,
  HpPayload,
  HpPricePayload,
  HpPriceRow,
} from '@terminal/core/functions/manifests/HP';
import { hpColumn } from '@terminal/core/functions/manifests/HP';
import type { AssetClass, FieldId } from '@terminal/core';

import { canonicalJson, sha256Hex } from '@terminal/core';

import { HISTORY_FIELDS } from '../../data/historical.js';
import { citeProvenance } from '../../data/reference.js';
import { ValidationFailedError } from '../../http/errors.js';
import { toSummary } from '../shared/instrumentSummary.js';
import { venueCalendar } from '../shared/returns.js';
import { resolveSeriesVariant } from './series.js';
import { pageOf, resolveWindow } from './window.js';

import type { FunctionResolver } from '../context.js';
import type { ResolveContext } from '../context.js';

/** The two columns `data.historical.bars` cannot serve; they are differences between its rows. */
const DERIVED_FIELDS: ReadonlySet<FieldId> = new Set<FieldId>(['CHG_NET_1D', 'CHG_PCT_1D']);

const STATS_ENGINE = { name: 'stats', version: '1.0.0' } as const;

/** `YYYY-MM-DD` of an instant, in UTC — every session date in the schema is a UTC date. */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// price
// ─────────────────────────────────────────────────────────────────────────────────────────────

const resolvePrice: FunctionResolver<HpParams, HpPayload> = async (ctx, params) => {
  const instrument = requireInstrument(ctx);
  const detail = await ctx.data.reference.instrument(instrument.instrumentId);
  const venue = await venueCalendar(ctx, detail);
  const subject = ctx.plant.subjectFor(instrument.instrumentId);
  const state = ctx.plant.snapshot(subject);
  const sessionOpen = state?.session === 'open';

  if (venue.calendar === null) {
    ctx.unavailable.add({
      field: 'window.end',
      reason: 'NO_SOURCE',
      detail: `no calendar seeded for ${venue.label}`,
    });
  }

  const window = resolveWindow({
    range: params.range,
    start: params.start,
    end: params.end,
    asOfDate: utcDate(ctx.asOf.validAt),
    calendar: venue.calendar,
    sessionOpen,
    firstTradeDate: detail.instrument.firstTradeDate,
  });
  if ('error' in window) {
    throw new ValidationFailedError(
      'fnParams',
      [{ path: ['start'], message: "range 'CUSTOM' requires a start date" }],
    );
  }

  // Every requested field the bar reader can serve, plus `PX_LAST`: the close is the input to the
  // change columns, to the summary's return and to the high/low dates, so it is read even when the
  // user did not ask for the column.
  const stored = params.fields.filter((f) => !DERIVED_FIELDS.has(f));
  const requested = [...new Set<FieldId>([...stored, 'PX_LAST'])].filter((f) =>
    HISTORY_FIELDS.includes(f),
  );

  const block = await ctx.data.historical.bars(instrument.instrumentId, {
    start: window.start,
    end: window.end,
    periodicity: params.periodicity,
    adjust: params.adjust,
    ...(params.currency === undefined ? {} : { currency: params.currency }),
    fields: requested,
  });

  const columnOf = new Map(block.columns.map((id, i) => [id, i]));
  const closeAt = columnOf.get('PX_LAST');
  const highAt = columnOf.get('PX_HIGH');
  const lowAt = columnOf.get('PX_LOW');
  const volumeAt = columnOf.get('PX_VOLUME');
  const trAt = columnOf.get('TOT_RETURN_INDEX');

  const factors = cumulativeFactors(
    block.index,
    block.adjustments.map((a) => ({
      beforeDate: a.beforeDate,
      priceFactor: a.priceFactor,
      volumeFactor: a.volumeFactor,
      kind: a.kind,
    })),
  );

  const wantsDerived = params.fields.some((f) => DERIVED_FIELDS.has(f));
  if (wantsDerived) {
    ctx.engines.add({
      ...STATS_ENGINE,
      inputsHash: inputsHash({
        window,
        periodicity: params.periodicity,
        adjust: params.adjust,
        closes: block.index.map((date, i) => [date, valueAt(block.rows, i, closeAt)]),
      }),
    });
  }

  // How many daily sessions each bucket aggregated. The reader resamples internally and reports
  // only the roll-up, but it stamps each bucket with the date of the session that *closed* it —
  // so bucket `i` covers exactly the daily sessions in `(index[i-1], index[i]]`. One extra
  // partition-pruned scan for a W/M/Q/Y table, and none at all for the daily one.
  const sessionsPerRow = await bucketSizes(ctx, instrument.instrumentId, params, window, block.index);

  const all: HpPriceRow[] = block.index.map((date, i) => {
    const close = valueAt(block.rows, i, closeAt);
    const previousClose = i === 0 ? null : valueAt(block.rows, i - 1, closeAt);
    const chgNet = close === null || previousClose === null ? null : close - previousClose;
    const chgPct =
      close === null || previousClose === null || previousClose === 0
        ? null
        : (close / previousClose - 1) * 100;

    const v = params.fields.map((field) => {
      if (field === 'CHG_NET_1D') return chgNet;
      if (field === 'CHG_PCT_1D') return chgPct;
      return valueAt(block.rows, i, columnOf.get(field));
    });

    const factor = factors[i];
    return {
      date,
      v,
      adjFactor: factor?.priceFactor ?? 1,
      volumeFactor: factor?.volumeFactor ?? 1,
      sessions: sessionsPerRow[i] ?? 1,
    };
  });

  // The summary is over the whole window and is therefore identical on every page.
  const closes = block.index
    .map((date, i) => ({ date, v: valueAt(block.rows, i, closeAt) }))
    .filter((p): p is { date: string; v: number } => p.v !== null);
  const highs = extremum(block, highAt ?? closeAt, 'max');
  const lows = extremum(block, lowAt ?? closeAt, 'min');
  const volumes = block.index
    .map((_, i) => valueAt(block.rows, i, volumeAt))
    .filter((n): n is number => n !== null && n > 0);

  const first = closes[0]?.v ?? null;
  const last = closes.at(-1)?.v ?? null;
  const trFirst = trAt === undefined ? null : firstNonNull(block, trAt);
  const trLast = trAt === undefined ? null : lastNonNull(block, trAt);
  const totalReturnPct =
    trFirst === null || trLast === null || trFirst === 0 ? null : (trLast / trFirst - 1) * 100;

  if (totalReturnPct === null) {
    ctx.unavailable.add({
      field: 'summary.totalReturnPct',
      reason: trAt === undefined ? 'NOT_APPLICABLE' : 'NO_SOURCE',
      detail:
        trAt === undefined
          ? 'TOT_RETURN_INDEX was not requested; add it to FLDS to see the total return'
          : 'no dividend history',
    });
  }

  const quoteCurrency = detail.instrument.currency;
  const converted =
    params.currency !== undefined && params.currency !== quoteCurrency
      ? { from: quoteCurrency, to: params.currency }
      : null;

  if (all.length === 0) {
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail:
        // A conversion with no published rate loses every row (`data/historical.ts` drops a
        // session it cannot price rather than pricing it at the wrong rate), and saying "no daily
        // bars" there would send the reader looking in the wrong place.
        converted !== null
          ? `no ECB rate for ${converted.to}`
          : instrument.assetClass === 'crypto'
            ? 'no daily history source for crypto (context only)'
            : 'no daily bars in window',
    });
  }

  const ordered = params.order === 'asc' ? all : [...all].reverse();
  const slice = pageOf(ordered, ctx.page, params.pageSize);
  ctx.page?.set({ index: slice.index, count: slice.count, cursor: slice.cursor });

  const payload: HpPricePayload = {
    variant: 'price',
    instrument: toSummary(detail),
    columns: params.fields.map((id): HpColumn => hpColumn(id)),
    rows: slice.rows,
    summary: {
      first,
      last,
      high: highs?.v ?? null,
      highDate: highs?.date ?? null,
      low: lows?.v ?? null,
      lowDate: lows?.date ?? null,
      priceReturnPct: first === null || first === 0 || last === null ? null : (last / first - 1) * 100,
      totalReturnPct,
      avgVolume:
        volumes.length === 0 ? null : volumes.reduce((a, b) => a + b, 0) / volumes.length,
      bars: all.length,
      firstDate: block.index[0] ?? null,
      lastDate: block.index.at(-1) ?? null,
    },
    window: { start: window.start, end: window.end, range: params.range },
    periodicity: params.periodicity,
    adjust: params.adjust,
    currency: block.currency,
    converted,
    calendarId: venue.calendarId ?? '',
    sessionOpen,
    provIdx: await citeBlock(ctx, block.rowProvenanceIds),
  };

  return payload;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// series
// ─────────────────────────────────────────────────────────────────────────────────────────────

const resolveSeries: FunctionResolver<HpParams, HpPayload> = async (ctx, params) => {
  const instrument = requireInstrument(ctx);
  const detail = await ctx.data.reference.instrument(instrument.instrumentId);

  // A curve, a fixing and an economic release are published on their own calendars, and none of
  // them is the instrument's venue calendar (a Treasury has no listing at all). The window is
  // therefore taken on raw dates and the rows are whatever was published inside it.
  const window = resolveWindow({
    range: params.range,
    start: params.start,
    end: params.end,
    asOfDate: utcDate(ctx.asOf.validAt),
    calendar: null,
    sessionOpen: false,
    firstTradeDate: detail.instrument.firstTradeDate,
  });
  if ('error' in window) {
    throw new ValidationFailedError('fnParams', [
      { path: ['start'], message: "range 'CUSTOM' requires a start date" },
    ]);
  }

  const payload = await resolveSeriesVariant({
    ctx,
    params,
    detail,
    window: { start: window.start, end: window.end, range: params.range },
  });

  const ordered = params.order === 'asc' ? payload.rows : [...payload.rows].reverse();
  const slice = pageOf(ordered, ctx.page, params.pageSize);
  ctx.page?.set({ index: slice.index, count: slice.count, cursor: slice.cursor });

  return { ...payload, rows: slice.rows };
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const variants: Partial<Record<AssetClass, FunctionResolver<HpParams, HpPayload>>> = {
  equity: resolvePrice,
  etf: resolvePrice,
  index: resolvePrice,
  fx: resolvePrice,
  crypto: resolvePrice,
  govt: resolveSeries,
  rate: resolveSeries,
  econ: resolveSeries,
};

/**
 * The dispatcher. The runner picks `variants[assetClass]` first, so this only runs for a class the
 * map does not name — which the manifest's `assetClasses` list already makes a 422 before the
 * resolver is reached. Defaulting to the price reader keeps that unreachable branch honest.
 */
export const resolve: FunctionResolver<HpParams, HpPayload> = (ctx, params) => {
  const assetClass = ctx.instrument?.assetClass;
  const variant = assetClass === undefined ? undefined : variants[assetClass];
  return (variant ?? resolvePrice)(ctx, params);
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────


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

function requireInstrument(ctx: ResolveContext): NonNullable<ResolveContext['instrument']> {
  const instrument = ctx.instrument;
  if (instrument === null) {
    // `requiresSecurity: true` makes this a 422 at runner step 3; reaching it means the manifest
    // and the resolver disagree, which is a defect rather than a user error.
    throw new Error('HP requires a security context.');
  }
  return instrument;
}

function valueAt(rows: readonly (number | null)[][], i: number, at: number | undefined): number | null {
  if (at === undefined) return null;
  return rows[i]?.[at] ?? null;
}

function firstNonNull(
  block: { index: readonly string[]; rows: readonly (number | null)[][] },
  at: number,
): number | null {
  for (let i = 0; i < block.index.length; i += 1) {
    const v = valueAt(block.rows, i, at);
    if (v !== null) return v;
  }
  return null;
}

function lastNonNull(
  block: { index: readonly string[]; rows: readonly (number | null)[][] },
  at: number,
): number | null {
  for (let i = block.index.length - 1; i >= 0; i -= 1) {
    const v = valueAt(block.rows, i, at);
    if (v !== null) return v;
  }
  return null;
}

function extremum(
  block: { index: readonly string[]; rows: readonly (number | null)[][] },
  at: number | undefined,
  which: 'max' | 'min',
): { date: string; v: number } | null {
  if (at === undefined) return null;
  let best: { date: string; v: number } | null = null;
  for (const [i, date] of block.index.entries()) {
    const v = valueAt(block.rows, i, at);
    if (v === null) continue;
    if (best === null || (which === 'max' ? v > best.v : v < best.v)) best = { date, v };
  }
  return best;
}

/** ANAL-08: the engine entry names what it was computed from, not when. */
function inputsHash(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}

/**
 * How many daily sessions each resampled row aggregated.
 *
 * `data/historical.ts` stamps a bucket with the date of the session that closed it, so the
 * buckets partition the daily index at exactly those dates: row `i` covers every daily session
 * after `index[i-1]` and up to `index[i]`. Counting them needs the daily index, which is one more
 * scan of the same partitions — and only for a W/M/Q/Y table, since a daily row is one session by
 * definition.
 */
async function bucketSizes(
  ctx: ResolveContext,
  instrumentId: number,
  params: HpParams,
  window: { start: string; end: string },
  index: readonly string[],
): Promise<number[]> {
  if (params.periodicity === 'D') return index.map(() => 1);
  if (index.length === 0) return [];

  const daily = await ctx.data.historical.bars(instrumentId, {
    start: window.start,
    end: window.end,
    periodicity: 'D',
    adjust: params.adjust,
    ...(params.currency === undefined ? {} : { currency: params.currency }),
    fields: ['PX_LAST'],
  });

  const sizes: number[] = [];
  let at = 0;
  for (const boundary of index) {
    let count = 0;
    while (at < daily.index.length && (daily.index[at] ?? '') <= boundary) {
      count += 1;
      at += 1;
    }
    sizes.push(count);
  }
  return sizes;
}
