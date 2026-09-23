/**
 * `functions/GIP/resolve.ts` — the intraday chart (FUNCTIONS_TIER1.md §GIP L551-657).
 *
 * ## Why this is not `GP 1D`
 *
 * The last bar of an open session is **provisional**. It is not in `bars_intraday` with
 * `is_final = true`, it comes from the plant's `b1m:` composite, and it changes every few seconds
 * until an `IS_FINAL:true` delta seals it. GIP keeps it in its own payload key — `forming` — so a
 * screen, a CSV and a golden can never mistake a bar that is still moving for a closed one
 * (TERM-12). `bars` holds sealed bars and nothing else.
 *
 * ## VWAP
 *
 * §GIP names the engine `vwap@1.0.0` and points it at `core/analytics/stats#vwap`. No such export
 * exists — `core/analytics/stats` has the returns/vol/beta family and nothing about volume-weighted
 * prices — and `packages/core` is another package's file set, so the cumulative sum is computed
 * here instead, to §GIP's definition exactly (typical price `(h+l+c)/3`, weighted by volume,
 * accumulated per **regular** session and `NaN` everywhere else). The engine entry is still
 * `vwap@1.0.0`, because that is what the number is, and the deviation is reported rather than
 * hidden behind a different engine name.
 *
 * ## The three ways a number can be absent
 *
 * An index and a currency pair have no volume at all, so VWAP is `NOT_APPLICABLE` — not zero, and
 * not an empty array that renders as a flat line at the bottom of the pane. A window with no bars
 * (a holiday, a provider outage) is `NO_SOURCE` and the chart draws the session frame only. A
 * field the caller may not see arrives from `plant.snapshot` already blank with its reason
 * (ENTL-05). All three are `null` in the payload with an entry in `meta`, which is what the
 * runner's payload-honesty check looks for.
 */

import { and, eq, sql } from 'drizzle-orm';

import type { GipParams, GipPayload, GipSessionBand, GipStats } from '@terminal/core/functions/manifests/GIP';
import { canonicalJson, sha256Hex } from '@terminal/core';
import type { AssetClass, FieldId, ValueCell } from '@terminal/core';

import { exchanges, listings } from '../../db/schema/index.js';
import type { IntradaySeries } from '../../data/intraday.js';
import { citeProvenance } from '../../data/reference.js';
import { ProviderUnavailableError } from '../context.js';
import { cellFromState, storedCell } from '../shared/cells.js';
import { toSummary } from '../shared/instrumentSummary.js';
import { venueCalendar } from '../shared/returns.js';

import type { FunctionResolver, ResolveContext } from '../context.js';
import type { CellState } from '../shared/cells.js';

const VWAP_ENGINE = { name: 'vwap', version: '1.0.0' } as const;
const STATS_ENGINE = { name: 'stats', version: '1.0.0' } as const;

const INTERVAL_MS: Readonly<Record<'1m' | '5m', number>> = { '1m': 60_000, '5m': 300_000 };

/** Asset classes whose tape carries no share volume, so VWAP is not a quantity that exists. */
const NO_VOLUME: ReadonlySet<AssetClass> = new Set<AssetClass>(['index', 'fx']);

/** How many daily sessions `VOLUME_AVG_30D` is the mean of, and the floor below which it is not. */
const AVG_VOLUME_SESSIONS = 30;
const AVG_VOLUME_MIN_SESSIONS = 5;

export const resolve: FunctionResolver<GipParams, GipPayload> = async (ctx, params) => {
  const instrument = ctx.instrument;
  if (instrument === null) {
    // `requiresSecurity: true` makes this a 422 at runner step 3; reaching it is a defect.
    throw new Error('GIP requires a security context.');
  }
  const instrumentId = instrument.instrumentId;

  const detail = await ctx.data.reference.instrument(instrumentId);
  const venue = await venueCalendar(ctx, detail);
  const tz = await exchangeTz(ctx, instrumentId, instrument.assetClass);

  const days = Number(params.days) as 1 | 2 | 5;
  // §GIP params: five days forces 5m. The payload echoes the *effective* interval, never the
  // requested one, so the CSV header and the chart agree with the bars they describe.
  const interval: '1m' | '5m' = days === 5 ? '5m' : params.interval;

  const quoteSubject = ctx.plant.subjectFor(instrumentId);
  const barSubject = ctx.plant.subjectFor(instrumentId, 'b1m');
  ctx.plant.ensureHot([quoteSubject, barSubject]);
  const state = ctx.plant.snapshot(quoteSubject);
  const formingState = ctx.plant.snapshot(barSubject);

  const query = { days, interval, session: params.session } as const;
  let block = await ctx.data.intraday.bars(instrumentId, query);

  // §GIP step 3: one read-through, and only when the session is open and what is stored has
  // fallen behind. A closed session's bars are complete by definition, and re-fetching them would
  // spend a provider budget to learn nothing.
  if (needsRefresh(block, state, interval, ctx)) {
    const line = primaryLine(detail);
    if (line !== null) {
      try {
        await ctx.providers.ensure('yahoo.intraday', line.providerSymbol, { maxAgeMs: 60_000 });
        block = await ctx.data.intraday.bars(instrumentId, query);
      } catch (error) {
        // Circuit open with nothing stored is a 503 the runner turns into PROVIDER_UNAVAILABLE;
        // with something stored the reader already has it and the bars are simply older.
        if (!(error instanceof ProviderUnavailableError)) throw error;
      }
    }
  }

  const bars = barsOf(block);
  const provIdx = (await citeBlock(ctx, block.rowProvenanceIds))[0] ?? -1;

  if (bars.t.length === 0) {
    ctx.unavailable.add({
      field: 'bars',
      reason: 'NO_SOURCE',
      detail:
        instrument.assetClass === 'crypto'
          ? 'intraday bars resampled from 60-second polls; context only'
          : 'no intraday bars in window (holiday or provider outage)',
    });
  } else if (instrument.assetClass === 'crypto') {
    ctx.unavailable.add({
      field: 'bars',
      reason: 'NO_SOURCE',
      detail: 'intraday bars resampled from 60-second polls; context only',
    });
  }

  const sessions = sessionBands(block, tz);
  const forming = formingBarOf(ctx, formingState, barSubject, interval, bars.t);
  const vwap = vwapOf(ctx, params, instrument.assetClass, bars, sessions);

  const prevClose = cellFromState(ctx, state, 'PX_CLOSE_1D', quoteSubject);
  const stats = await statsOf({
    ctx,
    state,
    subject: quoteSubject,
    instrumentId,
    vwap,
    provIdx,
    assetClass: instrument.assetClass,
  });

  const line = primaryLine(detail);

  const payload: GipPayload = {
    variant: 'intraday',
    instrument: toSummary(detail),
    interval,
    days,
    tz,
    calendarId: venue.calendarId ?? '',
    bars: { ...bars, provIdx },
    forming,
    sessions,
    vwap,
    // The series is derived from the bar block, so it cites the bar block (§0.4 rule 4) — the same
    // idx `vwapNow` already carries. `-1` only when there is no series to cite for.
    vwapProvIdx: vwap === null ? -1 : provIdx,
    prevClose,
    stats,
    sourceLine: {
      mdLineId: line?.mdLineId ?? -1,
      sourceId: line?.sourceId ?? '',
      providerSymbol: line?.providerSymbol ?? '',
      intrinsicDelayMin: line?.intrinsicDelayMin ?? 0,
    },
  };

  if (venue.calendarId === null) {
    ctx.unavailable.add({
      field: 'calendarId',
      reason: 'NO_SOURCE',
      detail: `no calendar seeded for ${venue.label}`,
    });
  }

  return payload;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Bars
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Bars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

/**
 * The block's columns as the five parallel arrays the canvas draws.
 *
 * A missing open/high/low falls back to the close and a missing volume to zero, because these are
 * typed arrays a chart indexes by position: a hole would have to be `NaN`, and `NaN` in `o` on a
 * candle chart is a candle that cannot be drawn at all. The close is never null — `bars_daily` and
 * `bars_intraday` both make it `NOT NULL` — so the fallback always has a value to use.
 */
function barsOf(block: IntradaySeries): Bars {
  const at = (id: FieldId): number => block.columns.indexOf(id);
  const oAt = at('PX_OPEN');
  const hAt = at('PX_HIGH');
  const lAt = at('PX_LOW');
  const cAt = at('PX_LAST');
  const vAt = at('PX_VOLUME');

  const bars: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const [i, ts] of block.index.entries()) {
    const row = block.rows[i] ?? [];
    const close = cAt < 0 ? null : (row[cAt] ?? null);
    if (close === null) continue;
    bars.t.push(Date.parse(ts));
    bars.o.push(pick(row, oAt) ?? close);
    bars.h.push(pick(row, hAt) ?? close);
    bars.l.push(pick(row, lAt) ?? close);
    bars.c.push(close);
    bars.v.push(pick(row, vAt) ?? 0);
  }
  return bars;
}

function pick(row: readonly (number | null)[], at: number): number | null {
  return at < 0 ? null : (row[at] ?? null);
}

/** The service's bands, as epoch ms plus the local session date the band belongs to. */
function sessionBands(block: IntradaySeries, tz: string): GipSessionBand[] {
  return block.sessions.map((band) => ({
    start: Date.parse(band.start),
    end: Date.parse(band.end),
    kind: band.kind,
    date: localDate(Date.parse(band.start), tz),
  }));
}

/** `YYYY-MM-DD` of an instant in `tz` — the session's own date, not the UTC one. */
function localDate(ms: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ms));
    return parts;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * The provisional bar the plant holds on `b1m:<id>`, or `null`.
 *
 * Four guards, each one a way a "live" bar could be a lie (TERM-12):
 *  - no `b1m:` state at all — nothing is forming;
 *  - `IS_FINAL` already true — the bar is sealed and belongs in `bars`, not here;
 *  - no `BAR_TS` — a bar with no start is not a bar;
 *  - a `BAR_TS` at or before the last sealed bar — the plant is behind the store, and showing it
 *    would draw the same minute twice.
 */
function formingBarOf(
  ctx: ResolveContext,
  state: CellState | undefined,
  subject: string,
  interval: '1m' | '5m',
  sealed: readonly number[],
): GipPayload['forming'] {
  if (state === undefined) return null;
  const f = state.fields as Record<string, unknown>;
  if (f.IS_FINAL === true) return null;

  const t = typeof f.BAR_TS === 'number' ? f.BAR_TS : null;
  const close = typeof f.PX_LAST === 'number' ? f.PX_LAST : null;
  if (t === null || close === null) return null;

  const lastSealed = sealed.at(-1);
  if (lastSealed !== undefined && t <= lastSealed) return null;
  // A forming bar must be the bar *after* the last sealed one, not an arbitrary later instant.
  if (lastSealed !== undefined && t - lastSealed > INTERVAL_MS[interval] * 2) return null;

  const num = (key: string): number | null => (typeof f[key] === 'number' ? (f[key]) : null);
  return {
    t,
    o: num('PX_OPEN') ?? close,
    h: num('PX_HIGH') ?? close,
    l: num('PX_LOW') ?? close,
    c: close,
    v: num('PX_VOLUME') ?? 0,
    isFinal: false,
    provIdx: ctx.prov.addQuote(state),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VWAP
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cumulative VWAP per regular session, aligned to `bars.t`.
 *
 * `NaN` outside a regular session (and before the first traded bar of one) rather than a carried
 * value or a zero: the chart reads `NaN` as a gap in the line, which is the truth — there is no
 * volume-weighted average price for a pre-market minute of a session that has not opened.
 */
function vwapOf(
  ctx: ResolveContext,
  params: GipParams,
  assetClass: AssetClass,
  bars: Bars,
  sessions: readonly GipSessionBand[],
): number[] | null {
  if (!params.vwap) {
    // A `null` cell is a `null` cell even when the user asked for it: the runner's payload-honesty
    // check wants a reason for every gap, and "you turned it off" is a perfectly good one.
    ctx.unavailable.add({
      field: 'vwap',
      reason: 'NOT_APPLICABLE',
      detail: 'VWAP is switched off for this chart (V toggles it)',
    });
    return null;
  }
  if (NO_VOLUME.has(assetClass)) {
    ctx.unavailable.add({
      field: 'vwap',
      reason: 'NOT_APPLICABLE',
      detail: 'no volume for this instrument',
    });
    return null;
  }
  if (bars.t.length === 0) return [];

  const out: number[] = [];
  let sessionKey: string | null = null;
  let pv = 0;
  let volume = 0;

  for (const [i, t] of bars.t.entries()) {
    const band = sessions.find((b) => t >= b.start && t < b.end);
    if (band?.kind !== 'regular') {
      out.push(Number.NaN);
      continue;
    }
    if (band.date !== sessionKey) {
      sessionKey = band.date;
      pv = 0;
      volume = 0;
    }
    const v = bars.v[i] ?? 0;
    const typical = ((bars.h[i] ?? 0) + (bars.l[i] ?? 0) + (bars.c[i] ?? 0)) / 3;
    pv += typical * v;
    volume += v;
    out.push(volume === 0 ? Number.NaN : pv / volume);
  }

  ctx.engines.add({
    ...VWAP_ENGINE,
    inputsHash: sha256Hex(canonicalJson({ t: bars.t, h: bars.h, l: bars.l, c: bars.c, v: bars.v })),
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Statistics
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function statsOf(input: {
  ctx: ResolveContext;
  state: CellState | undefined;
  subject: string;
  instrumentId: number;
  vwap: number[] | null;
  provIdx: number;
  assetClass: AssetClass;
}): Promise<GipStats> {
  const { ctx, state, subject } = input;
  const cell = (field: FieldId): ValueCell => cellFromState(ctx, state, field, subject);

  const vwapNow = lastFinite(input.vwap);
  const volume = typeof state?.fields.PX_VOLUME === 'number' ? state.fields.PX_VOLUME : null;
  const avg = await avgVolume30d(ctx, input.instrumentId, input.assetClass);

  // §0.4 rule 4: a derived cell cites the provIdx of its **primary input**. For
  // `pctOfAvgVolume30d` that is today's session volume, which comes from the quote — not from the
  // intraday bar block, whose idx is `-1` whenever the window loaded no bars (a five-day 5m chart
  // over a holiday week, say) while the quote still carries a volume. Citing the bar block there
  // published a finite number at `provIdx: -1`, which is the value §0.4 rule 1 reserves for a cell
  // that has no value at all.
  const volumeCell = cell('PX_VOLUME');

  let pctOfAvg: ValueCell;
  if (avg === null || volume === null || avg === 0) {
    pctOfAvg = { v: null, st: 'na', provIdx: -1 };
    ctx.unavailable.add({
      field: 'stats.pctOfAvgVolume30d',
      reason: 'NO_SOURCE',
      detail: `fewer than ${String(AVG_VOLUME_MIN_SESSIONS)} daily bars`,
    });
  } else if (volumeCell.provIdx < 0) {
    pctOfAvg = { v: null, st: 'na', provIdx: -1 };
    ctx.unavailable.add({
      field: 'stats.pctOfAvgVolume30d',
      reason: 'NO_SOURCE',
      detail: 'the session volume this is a percentage of carries no provenance',
    });
  } else {
    ctx.engines.add({
      ...STATS_ENGINE,
      inputsHash: sha256Hex(canonicalJson({ volume, avg })),
    });
    pctOfAvg = storedCell({ v: (volume / avg) * 100, provIdx: volumeCell.provIdx });
  }

  // The same rule for `vwapNow`: it is the last point of the VWAP series, which is derived from
  // the bar block, so it cites the bar block — and is absent with a reason when there is none.
  let vwapCell: ValueCell;
  if (vwapNow === null) {
    vwapCell = { v: null, st: 'na', provIdx: -1 };
  } else if (input.provIdx < 0) {
    vwapCell = { v: null, st: 'na', provIdx: -1 };
    ctx.unavailable.add({
      field: 'stats.vwapNow',
      reason: 'NO_SOURCE',
      detail: 'the bar block the VWAP is computed from carries no provenance',
    });
  } else {
    vwapCell = storedCell({ v: vwapNow, provIdx: input.provIdx });
  }

  return {
    open: cell('PX_OPEN'),
    high: cell('PX_HIGH'),
    low: cell('PX_LOW'),
    last: cell('PX_LAST'),
    chgNet: cell('CHG_NET_1D'),
    chgPct: cell('CHG_PCT_1D'),
    volume: volumeCell,
    vwapNow: vwapCell,
    pctOfAvgVolume30d: pctOfAvg,
    sessionState: cell('SESSION_STATE'),
  };
}

function lastFinite(values: readonly number[] | null): number | null {
  if (values === null) return null;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * The mean of the last 30 daily sessions with volume, or `null` below five of them.
 *
 * Five is the floor §GIP's reason code names: a "30-day average" off three days is a number with
 * the wrong name on it, and the screen's `% of 30-d avg` would be meaningless precision.
 */
async function avgVolume30d(
  ctx: ResolveContext,
  instrumentId: number,
  assetClass: AssetClass,
): Promise<number | null> {
  if (NO_VOLUME.has(assetClass)) return null;
  const end = ctx.asOf.validAt.toISOString().slice(0, 10);
  // 60 calendar days back covers 30 sessions with room for holidays; the query takes the newest
  // 30 rows that actually carry volume.
  const start = new Date(ctx.asOf.validAt.getTime() - 120 * 86_400_000).toISOString().slice(0, 10);

  try {
    const block = await ctx.data.historical.bars(instrumentId, {
      start,
      end,
      periodicity: 'D',
      adjust: 'unadjusted',
      fields: ['PX_VOLUME'],
    });
    const at = block.columns.indexOf('PX_VOLUME');
    if (at < 0) return null;
    const volumes = block.rows
      .map((row) => row[at] ?? null)
      .filter((v): v is number => v !== null && v > 0)
      .slice(-AVG_VOLUME_SESSIONS);
    if (volumes.length < AVG_VOLUME_MIN_SESSIONS) return null;
    return volumes.reduce((a, b) => a + b, 0) / volumes.length;
  } catch {
    // A security with no `bars_daily` partition at all is the same answer as too few rows.
    return null;
  }
}

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

/** The line the chart is fed by: lowest `priority` wins, as in the composite merge (BUS-05). */
function primaryLine(detail: { mdLines: readonly { mdLineId: number; sourceId: string; providerSymbol: string; intrinsicDelayMin: number; priority: number }[] }) {
  const lines = [...detail.mdLines].sort((a, b) => a.priority - b.priority || a.mdLineId - b.mdLineId);
  return lines[0] ?? null;
}

/**
 * §GIP step 3's freshness test: an **open** session whose newest stored final bar is older than
 * two intervals, or a window with no bars at all.
 */
function needsRefresh(
  block: IntradaySeries,
  state: CellState | undefined,
  interval: '1m' | '5m',
  ctx: ResolveContext,
): boolean {
  if (state?.session !== 'open') return false;
  const last = block.index.at(-1);
  if (last === undefined) return true;
  return ctx.clock.now() - Date.parse(last) > INTERVAL_MS[interval] * 2;
}

/** `listings.mic → exchanges.tz`; fx and crypto quote round the clock and report UTC. */
async function exchangeTz(
  ctx: ResolveContext,
  instrumentId: number,
  assetClass: AssetClass,
): Promise<string> {
  if (assetClass === 'fx' || assetClass === 'crypto') return 'UTC';
  const rows = await ctx.db
    .select({ tz: exchanges.tz })
    .from(listings)
    .innerJoin(exchanges, eq(exchanges.mic, listings.mic))
    .where(
      and(
        eq(listings.instrumentId, instrumentId),
        sql`bt_as_of(${listings.validFrom}, ${listings.validTo}, ${listings.txFrom}, ${listings.txTo},
                     ${ctx.asOf.validAt.toISOString()}::timestamptz, ${ctx.asOf.knownAt.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(sql`${listings.isPrimary} DESC`, listings.listingId)
    .limit(1);
  return rows[0]?.tz ?? 'UTC';
}
