/**
 * `functions/WEI/resolve.ts` — the world index monitor (FUNCTIONS_TIER1.md §WEI L1893-2067).
 *
 * WEI is the workspace's first frame, so it never blocks on a provider: §0.4 rule 2 forbids a
 * monitor from calling `ctx.providers.ensure` at all. An index with no recorded quote is **pending**
 * — `st:'blank'`, `provIdx:-1`, no reason code — and the scheduler fills it a moment later over the
 * WebSocket. That is not a degraded mode; it is the honest one. The alternative (ensure thirteen
 * subjects on first paint) turns a 300 ms screen into a thirteen-provider fan-out and makes the
 * golden depend on which fixtures happen to be recorded.
 *
 * The other rule that shapes this file is **local currency**. Values are each index's own
 * `calc_currency` and are never converted. A USD-normalised WEI would look more comparable and be
 * wrong: the Nikkei's day is the Nikkei's day, not the Nikkei's day plus the yen's.
 *
 * Three degradations, each with a footer code rather than a guess (§WEI "Unavailable"):
 *   - no seeded daily history → every `RET_*`, 52-week and `VOL_30D` cell is `st:'na'`
 *     (`NO_DAILY_HISTORY`);
 *   - no seeded calendar for the venue and no provider status → `sessionState:'unknown'`,
 *     `sessionSource:'none'` (`NO_CALENDAR_FOR_VENUE`) — never an invented session;
 *   - an `index_terms.region` outside Americas/EMEA/APAC → the row is omitted with the string
 *     quoted back (`REGION_UNMAPPED`), rather than dropped into a bucket it does not belong to.
 */

import { sql } from 'drizzle-orm';

import type { AssetClass, FieldId, MarketSector, SessionState, ValueCell } from '@terminal/core';
import { monitorColumn } from '@terminal/core';
import type {
  WeiCounts,
  WeiMethodology,
  WeiParams,
  WeiPayload,
  WeiRegion,
  WeiRegionBlock,
  WeiRow,
  WeiSessionSource,
  WeiSkipped,
} from '@terminal/core/functions/manifests/WEI';
import {
  WEI_LEVEL_COLUMNS,
  WEI_REGION_LABELS,
  weiRegionBucket,
} from '@terminal/core/functions/manifests/WEI';
import type { MonitorColumn } from '@terminal/core/functions/shared/monitor';
import {
  localClock,
  sessionCalendar,
  sessionState as sessionStateAt,
} from '@terminal/core/quote/session';

import type { GatedQuoteState, ResolveContext } from '../context.js';
import { cellFromState, pendingCell } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';
import type { PeriodBar } from '../shared/returns.js';
import { PERIOD_RETURNS_CONVENTIONS, periodReturns, recordPeriodMeta } from '../shared/returns.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The universe query (§WEI resolver step 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface UniverseRow extends Record<string, unknown> {
  code: string;
  instrument_id: string;
  membership_source_id: string | null;
  registry_provider: string;
  ticker: string;
  name: string;
  exch_code: string;
  asset_class: string;
  market_sector: string;
  currency: string;
  search_weight: number;
  terms_provider: string | null;
  methodology: string | null;
  calc_currency: string | null;
  region: string | null;
  mic: string | null;
  calendar_id: string | null;
  tz: string | null;
  md_line_count: string;
}

/**
 * Every seeded index with its as-of terms, its primary listing's venue and whether it has a line.
 *
 * One statement rather than five round-trips: §WEI's budget is two DB round-trips for the whole
 * screen, and thirteen indices × (terms + listing + exchange + line count) is the shape that turns
 * a monitor into a waterfall. The as-of predicates are `bt_as_of`, the same function
 * `db/bitemporal.ts#asOf` emits, so this read sees exactly what a repository read would.
 */
async function universe(
  ctx: ResolveContext,
  codes: readonly string[] | undefined,
): Promise<UniverseRow[]> {
  const validAt = ctx.asOf.validAt;
  const knownAt = ctx.asOf.knownAt;
  const filter =
    codes === undefined || codes.length === 0
      ? sql``
      : sql`AND i.code = ANY(${sql.param(codes)}::text[])`;

  const res = await ctx.db.execute<UniverseRow>(sql`
    SELECT i.code,
           ins.instrument_id::text        AS instrument_id,
           i.membership_source_id,
           i.provider                     AS registry_provider,
           ins.ticker, ins.name, ins.exch_code, ins.asset_class::text AS asset_class,
           ins.market_sector::text        AS market_sector,
           ins.currency, ins.search_weight,
           t.provider                     AS terms_provider,
           t.methodology, t.calc_currency, t.region,
           l.mic, e.calendar_id, e.tz,
           (SELECT count(*) FROM md_lines m
             WHERE m.instrument_id = ins.instrument_id
               AND m.line_kind <> 'reference'
               AND bt_as_of(m.valid_from, m.valid_to, m.tx_from, m.tx_to,
                            ${validAt}::timestamptz, ${knownAt}::timestamptz))::text AS md_line_count
      FROM indices i
      JOIN instruments ins
        ON ins.instrument_id = i.instrument_id
       AND bt_as_of(ins.valid_from, ins.valid_to, ins.tx_from, ins.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN index_terms t
        ON t.instrument_id = i.instrument_id
       AND bt_as_of(t.valid_from, t.valid_to, t.tx_from, t.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN listings l
        ON l.instrument_id = ins.instrument_id
       AND l.is_primary
       AND bt_as_of(l.valid_from, l.valid_to, l.tx_from, l.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN exchanges e ON e.mic = l.mic
     WHERE ins.asset_class = 'index'
       ${filter}
     ORDER BY ins.search_weight DESC, i.code ASC`);

  return [...res.rows];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const METHODOLOGIES: ReadonlySet<string> = new Set([
  'cap_weighted',
  'float_cap_weighted',
  'price_weighted',
  'equal_weighted',
  'volatility',
  'other',
]);

function methodologyOf(raw: string | null): WeiMethodology {
  return raw !== null && METHODOLOGIES.has(raw) ? (raw as WeiMethodology) : 'other';
}

/** `'YYYY-MM-DD'` of an instant, UTC. */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `start` of the bar window: 380 calendar days back, which covers 252 sessions plus holidays. */
function windowStart(asOfDate: string): string {
  const ms = Date.parse(`${asOfDate}T00:00:00.000Z`) - 380 * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** `'16:59:53 BST'`-style local time of `asOf` in the venue's zone; null when the zone is unknown. */
function localTimeOf(tz: string | null, atMs: number): string | null {
  if (tz === null) return null;
  const local = localClock(tz, atMs);
  if (local === undefined) return null;
  const hh = Math.floor(local.minuteOfDay / 60);
  const mm = local.minuteOfDay % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${tz}`;
}

/** A `SeriesBlock` → the bar shape `periodReturns` takes. */
function toPeriodBars(block: {
  columns: FieldId[];
  index: string[];
  rows: (number | null)[][];
}): PeriodBar[] {
  const at = (field: FieldId): number => block.columns.indexOf(field);
  const close = at('PX_LAST');
  const high = at('PX_HIGH');
  const low = at('PX_LOW');
  const volume = at('PX_VOLUME');
  const bars: PeriodBar[] = [];
  for (let i = 0; i < block.index.length; i += 1) {
    const row = block.rows[i];
    const date = block.index[i];
    if (row === undefined || date === undefined) continue;
    bars.push({
      date,
      close: close < 0 ? null : (row[close] ?? null),
      high: high < 0 ? null : (row[high] ?? null),
      low: low < 0 ? null : (row[low] ?? null),
      volume: volume < 0 ? null : (row[volume] ?? null),
    });
  }
  return bars;
}

/** The nine §0.6 figures, keyed by the field id each is published as. */
const DERIVED_FIELDS: Readonly<Record<string, FieldId>> = Object.freeze({
  ret1d: 'RET_1D',
  ret1w: 'RET_1W',
  ret1m: 'RET_1M',
  retYtd: 'RET_YTD',
  ret1y: 'RET_1Y',
  high52w: 'PX_HIGH_52W',
  low52w: 'PX_LOW_52W',
  avgVolume30d: 'VOLUME_AVG_30D',
  vol30d: 'VOL_30D',
});

const DERIVED_FIELD_IDS: ReadonlySet<string> = new Set(Object.values(DERIVED_FIELDS));

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: WeiParams): Promise<WeiPayload> {
  const asOfMs = ctx.asOf.validAt.getTime();
  const asOfDate = utcDate(ctx.asOf.validAt);
  const skipped: WeiSkipped[] = [];

  // 1 — the universe.
  const rows = await universe(ctx, params.codes);
  const seen = new Set(rows.map((r) => r.code));
  for (const code of params.codes ?? []) {
    if (!seen.has(code)) skipped.push({ code, reason: 'INDEX_NOT_SEEDED' });
  }

  // 3 — the columns (before the cells, because the cells are keyed by column id).
  const columnIds = params.view === 'levels' ? [...WEI_LEVEL_COLUMNS] : params.columns;
  const columns: MonitorColumn[] = columnIds.map((id) => monitorColumn(id));
  const plantColumns = columns.filter(
    (c) => c.fieldId !== undefined && !DERIVED_FIELD_IDS.has(c.fieldId),
  );
  const derivedColumns = columns.filter(
    (c) => c.fieldId !== undefined && DERIVED_FIELD_IDS.has(c.fieldId),
  );

  // 2 — bucket, filter, and keep the rows that can be a plant subject at all.
  interface Candidate {
    row: UniverseRow;
    region: WeiRegion;
    instrumentId: number;
    subject: string;
  }
  const candidates: Candidate[] = [];
  const wanted = new Set<WeiRegion>(params.regions);
  for (const row of rows) {
    if (Number(row.md_line_count) === 0) {
      skipped.push({ code: row.code, reason: 'NO_MD_LINE' });
      continue;
    }
    const region = weiRegionBucket(row.region);
    if (region === null) {
      ctx.unavailable.add({
        field: `rows.${row.code}`,
        reason: 'NOT_APPLICABLE',
        detail: `index_terms.region ${JSON.stringify(row.region)} is not one of Americas/EMEA/APAC`,
      });
      continue;
    }
    // `codes` is an explicit list and overrides the region filter (§WEI params).
    if (params.codes === undefined && !wanted.has(region)) continue;
    const instrumentId = Number(row.instrument_id);
    candidates.push({
      row,
      region,
      instrumentId,
      subject: ctx.plant.subjectFor(instrumentId),
    });
  }

  // 4 — live cells. `ensureHot` asks the scheduler to keep polling; it never blocks and never
  // fetches (§0.4 rule 2).
  const subjects = candidates.map((c) => c.subject);
  ctx.plant.ensureHot(subjects);
  const snapshots: Map<string, GatedQuoteState> = ctx.plant.snapshotMany(subjects);

  // Always true of WEI, and said once rather than implied by the absence of a column.
  ctx.unavailable.add({
    field: 'usdReturns',
    reason: 'NOT_APPLICABLE',
    detail: 'WEI shows local-currency index levels; no FX conversion is applied',
  });

  // 5 — one bar block per row, issued together.
  const start = windowStart(asOfDate);
  const barBlocks = await Promise.all(
    candidates.map(async (c) => {
      try {
        return await ctx.data.historical.bars(c.instrumentId, {
          start,
          end: asOfDate,
          periodicity: 'D',
          adjust: 'price',
          fields: ['PX_LAST', 'PX_HIGH', 'PX_LOW', 'PX_VOLUME'],
        });
      } catch {
        // A bar read that cannot be served is a missing history, not a failed screen: the row
        // keeps its live cells and its `RET_*` block goes `na` with the reason below.
        return null;
      }
    }),
  );

  const built: { region: WeiRegion; row: WeiRow }[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const u = c.row;
    const state = snapshots.get(c.subject);
    const cells: Record<string, ValueCell> = {};

    // The venue calendar, read once: the returns need it to find `t₋` on a session index, and
    // the session block needs it to say which phase `asOf` falls in. `reference.calendar` caches
    // per request, so two indices on one venue still read the holiday table once.
    const calendar =
      u.calendar_id === null
        ? null
        : await ctx.data.reference.calendar(u.calendar_id).catch(() => null);

    for (const column of plantColumns) {
      const field = column.fieldId!;
      cells[column.id] = cellFromState(ctx, state, field, c.subject);
    }

    // 5 — derived cells. Stored-value cells (§0.4 rule 3): `st:'closed'`, no `live`, and the
    // provenance of the bar block that produced them.
    const block = barBlocks[i] ?? null;
    const bars = block === null ? [] : toPeriodBars(block);
    const barsLoaded = bars.length;
    const barProvIdx = block?.provIdx[0] ?? -1;
    /**
     * Sessions the statistics actually ran on, not bar rows loaded.
     *
     * The lookback loads every bar in a 380-*calendar*-day window, and some of those rows fall on
     * days the venue was shut — eleven of SPX's 272 rows are XCBO holidays. `periodReturns` filters
     * them out through the calendar and reports what survived; reporting `bars.length` would tell a
     * user the screen has eleven more sessions of history than the numbers beside it used.
     * `periodReturns` is not called when the history is too short to run, and there the two counts
     * are equal anyway.
     */
    let historySessions = barsLoaded;

    if (derivedColumns.length > 0) {
      if (barsLoaded < 2) {
        ctx.unavailable.add({
          field: `rows.${u.code}.returns`,
          reason: 'NO_SOURCE',
          detail: `no daily history recorded for ${u.code}`,
        });
        for (const column of derivedColumns) cells[column.id] = { v: null, st: 'na', provIdx: -1 };
      } else {
        // `calendar: null` is not a shortcut to "compute on raw calendar days": `periodReturns`
        // answers every figure `null` with `NO_SOURCE` and the `NO_CALENDAR_FOR_VENUE` footer
        // code, which is §0.6's rule and the reason the argument is nullable at all.
        const values = periodReturns(bars, calendar, asOfDate, u.mic ?? 'this venue');
        recordPeriodMeta(ctx, values);
        historySessions = values.sessions;
        const lastBar = bars[bars.length - 1];
        const ts = lastBar === undefined ? null : Date.parse(`${lastBar.date}T00:00:00.000Z`);
        for (const column of derivedColumns) {
          const key = Object.keys(DERIVED_FIELDS).find((k) => DERIVED_FIELDS[k] === column.fieldId);
          const value =
            key === undefined
              ? null
              : ((values[key as keyof typeof values] as number | null | undefined) ?? null);
          cells[column.id] =
            value === null
              ? { v: null, st: 'na', provIdx: -1 }
              : { v: value, st: 'closed', ts, provIdx: barProvIdx };
        }
      }
    }

    // 6 — session. Calendar first, the provider's own status second, `unknown` last.
    let sessionState: SessionState = 'unknown';
    let sessionSource: WeiSessionSource = 'none';
    let calendarId: string | null = null;
    let localTime: string | null = null;

    if (u.calendar_id !== null && calendar !== null) {
      calendarId = u.calendar_id;
      // An index has no extended session: a pre-market print is not an index level.
      sessionState = sessionStateAt(sessionCalendar(calendar), asOfMs, false);
      sessionSource = 'calendar';
      localTime = localTimeOf(u.tz, asOfMs);
    }
    if (sessionSource === 'none') {
      const published = state?.fields.SESSION_STATE ?? state?.session;
      if (published !== undefined && published !== 'unknown') {
        sessionState = published;
        sessionSource = 'provider';
      } else {
        ctx.unavailable.add({
          field: `rows.${u.code}.session`,
          reason: 'NO_SOURCE',
          detail:
            `no calendar seeded for ${u.mic ?? 'this venue'} and the provider publishes no ` +
            'session state',
        });
      }
    }

    // An index source publishes no volume: the cell is `na`, never a zero (§WEI "Unavailable").
    const volumeCell = cells.PX_VOLUME;
    if (volumeCell?.v === 0) {
      cells.PX_VOLUME = { v: null, st: 'na', provIdx: volumeCell.provIdx };
      ctx.unavailable.add({
        field: `rows.${u.code}.PX_VOLUME`,
        reason: 'NOT_APPLICABLE',
        detail: 'the index source publishes no volume',
      });
    }

    built.push({
      region: c.region,
      row: {
        instrumentId: c.instrumentId,
        key: displayOf(u.ticker, u.exch_code, u.market_sector as MarketSector),
        name: u.name,
        assetClass: u.asset_class as AssetClass,
        marketSector: u.market_sector as MarketSector,
        exchCode: u.exch_code,
        gicsSector: null,
        subject: c.subject,
        cells,
        code: u.code,
        region: c.region,
        indexProvider: u.terms_provider ?? u.registry_provider,
        methodology: methodologyOf(u.methodology),
        calcCurrency: u.calc_currency ?? u.currency,
        mic: u.mic,
        calendarId,
        sessionState,
        sessionSource,
        localTime,
        membershipAvailable: u.membership_source_id !== null,
        historySessions,
      },
    });
  }

  // 7 — assemble, in `params.regions` order; empty regions are omitted.
  const order: WeiRegion[] =
    params.codes === undefined ? [...params.regions] : ['Americas', 'EMEA', 'APAC'];
  const regions: WeiRegionBlock[] = [];
  for (const region of order) {
    const rowsOfRegion = built.filter((b) => b.region === region).map((b) => b.row);
    if (rowsOfRegion.length === 0) continue;
    regions.push({ region, label: WEI_REGION_LABELS[region], rows: rowsOfRegion });
  }

  const counts: WeiCounts = { rows: 0, live: 0, pending: 0, stale: 0, blank: 0, na: 0 };
  for (const block of regions) {
    for (const row of block.rows) {
      counts.rows += 1;
      // A row is "pending" when its plant cells have never been filled: `provIdx: -1` and no
      // reason. A blank with a reason is a denial, which is a different thing entirely (§0.4).
      const pending = plantColumns.every((c) => {
        const cell = row.cells[c.id];
        return cell?.st === 'blank' && cell.provIdx === -1 && cell.r === undefined;
      });
      if (pending && plantColumns.length > 0) counts.pending += 1;
      for (const cell of Object.values(row.cells)) {
        if (cell.st === 'live') counts.live += 1;
        else if (cell.st === 'stale') counts.stale += 1;
        else if (cell.st === 'na') counts.na += 1;
        else if (cell.st === 'blank' && !pending) counts.blank += 1;
      }
    }
  }

  return {
    variant: 'default',
    regions,
    columns,
    view: params.view,
    sort: params.sort ?? null,
    conventions: PERIOD_RETURNS_CONVENTIONS,
    counts,
    skipped,
    asOf: ctx.asOf.validAt.toISOString(),
  };
}

/** `pendingCell` is the documented shape of a never-polled cell; re-exported for the tests. */
export { pendingCell };
