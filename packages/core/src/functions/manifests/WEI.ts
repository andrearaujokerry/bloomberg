// packages/core/src/functions/manifests/WEI.ts
//
// `WEI` — World Equity Indices (FUNCTIONS_TIER1.md §WEI L1893-2067, FUNCTIONS.md §6 L1087).
//
// The morning screen: every seeded equity index on one page, grouped Americas / EMEA / APAC, with
// the level, the change on the day, period returns, the 52-week range and the session state. Values
// are in each index's own calculation currency and are NEVER converted to USD — a currency-adjusted
// comparison is GP's job with an overlay, and silently converting here would make two screens
// disagree about what "the Nikkei did today" means.
//
// The §6 binding row is `none → default`: the rows are `index` instruments, the function takes no
// security.

import { z } from 'zod';

import type { Conventions } from '../../analytics/engine.js';
import type { FieldId } from '../../types/fields.js';
import type { SessionState } from '../../types/quote.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { FieldId as FieldIdSchema, SortSpec } from '../schemas.js';
import type { MonitorColumn, MonitorRow } from '../shared/monitor.js';
import { asOfCompact } from './Q.js';
import { monitorLive, monitorPrecheckFields, worstCellState } from './QM.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§WEI "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const WeiRegion = z.enum(['Americas', 'EMEA', 'APAC']);
export type WeiRegion = z.infer<typeof WeiRegion>;

/** The default `returns` view's columns, in order. */
export const WEI_RETURN_COLUMNS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'RET_1W',
  'RET_1M',
  'RET_YTD',
  'RET_1Y',
  'PX_HIGH_52W',
  'PX_LOW_52W',
  'SESSION_STATE',
]);

/** `VIEW=LEVELS` swaps the `RET_*` block for OHLC and volume (§WEI resolver step 3). */
export const WEI_LEVEL_COLUMNS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'PX_VOLUME',
  'LAST_TRADE_TIME',
  'SESSION_STATE',
]);

export const WeiParams = z.object({
  regions: z.array(WeiRegion).min(1).max(3).default(['Americas', 'EMEA', 'APAC']),
  columns: z
    .array(FieldIdSchema)
    .min(1)
    .max(20)
    .default([...WEI_RETURN_COLUMNS]),
  view: z.enum(['returns', 'levels']).default('returns'),
  /** Applied by the screen, within each region; carried in the payload so a re-sort is free. */
  sort: SortSpec.optional(),
  /** Explicit `indices.code` list; overrides `regions`. */
  codes: z.array(z.string().max(12)).max(40).optional(),
});
export type WeiParams = z.infer<typeof WeiParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§WEI "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type WeiMethodology =
  | 'cap_weighted'
  | 'float_cap_weighted'
  | 'price_weighted'
  | 'equal_weighted'
  | 'volatility'
  | 'other';

/** FEED-06: where the session verdict came from, so an `unknown` is never mistaken for a closure. */
export type WeiSessionSource = 'calendar' | 'provider' | 'none';

export interface WeiRow extends MonitorRow {
  /** `indices.code` — 'SPX', 'UKX', 'NKY'. */
  code: string;
  region: WeiRegion;
  /** `index_terms.provider`; null when no as-of terms row exists. */
  indexProvider: string | null;
  methodology: WeiMethodology;
  /** `index_terms.calc_currency` — the LOCAL currency, never USD-converted. */
  calcCurrency: string;
  /** `listings.mic` of the primary listing; null for a Yahoo-only index. */
  mic: string | null;
  /** `exchanges.calendar_id`; null when no calendar is seeded for the venue. */
  calendarId: string | null;
  sessionState: SessionState;
  sessionSource: WeiSessionSource;
  /** `asOf` rendered in `exchanges.tz`; null when `calendarId` is null. */
  localTime: string | null;
  /** `indices.membership_source_id !== null` — gates the `M` key. */
  membershipAvailable: boolean;
  /**
   * Sessions behind the `RET_*` cells: `bars_daily` rows that fall on a day the venue's calendar
   * says it was open. Bars loaded on a market holiday are excluded, because the statistics exclude
   * them. 0 → those cells are `na`.
   */
  historySessions: number;
}

export interface WeiRegionBlock {
  region: WeiRegion;
  label: string;
  rows: WeiRow[];
}

export interface WeiCounts {
  rows: number;
  live: number;
  pending: number;
  stale: number;
  blank: number;
  na: number;
}

export interface WeiSkipped {
  code: string;
  reason: 'INDEX_NOT_SEEDED' | 'NO_MD_LINE';
}

export interface WeiPayload {
  variant: 'default';
  /** In `params.regions` order; empty regions are omitted. */
  regions: WeiRegionBlock[];
  columns: MonitorColumn[];
  view: 'returns' | 'levels';
  sort: z.infer<typeof SortSpec> | null;
  /** §0.6, echoed so the `RET_*` basis is on the screen and in the CSV header (ANAL-07). */
  conventions: Conventions;
  counts: WeiCounts;
  skipped: WeiSkipped[];
  /** `ctx.asOf.validAt` — the instant the payload reproduces at. */
  asOf: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Region bucketing (§WEI resolver step 2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const REGION_ALIASES: Readonly<Record<string, WeiRegion>> = Object.freeze({
  'north america': 'Americas',
  americas: 'Americas',
  us: 'Americas',
  europe: 'EMEA',
  uk: 'EMEA',
  emea: 'EMEA',
  asia: 'APAC',
  pacific: 'APAC',
  apac: 'APAC',
});

/**
 * `index_terms.region` → one of the three buckets, or `null`.
 *
 * `null` is the important half. A region string outside the table is **not** dropped into APAC:
 * the row is omitted with a `NOT_APPLICABLE` note naming the string, because a FTSE MIB filed
 * under "Southern Europe" appearing in the APAC block is worse than it not appearing at all — the
 * screen would be quietly wrong rather than visibly incomplete.
 */
export function weiRegionBucket(region: string | null): WeiRegion | null {
  if (region === null) return null;
  return REGION_ALIASES[region.trim().toLowerCase()] ?? null;
}

export const WEI_REGION_LABELS: Readonly<Record<WeiRegion, string>> = Object.freeze({
  Americas: 'AMERICAS',
  EMEA: 'EMEA',
  APAC: 'APAC',
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§WEI "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The superset §WEI names, before {@link monitorPrecheckFields} (see its doc for why it filters). */
export const WEI_PRECHECK_SUPERSET: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'PX_OFFICIAL_CLOSE',
  'PX_VOLUME',
  'LAST_TRADE_TIME',
  'SESSION_STATE',
  'IVOL_30D',
  'RET_1W',
  'RET_1M',
  'RET_YTD',
  'RET_1Y',
  'PX_HIGH_52W',
  'PX_LOW_52W',
  'VOL_30D',
  'NAME',
  'ID_TICKER',
  'EXCH_CODE',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§WEI "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

function weiCsvColumns(_params: WeiParams, payload: WeiPayload): CsvColumn[] {
  const columns: CsvColumn[] = [
    { id: 'region', label: 'Region', type: 'string' },
    { id: 'code', label: 'Code', type: 'string' },
    { id: 'key', label: 'Security', type: 'string' },
    { id: 'name', label: 'Name', type: 'string' },
    { id: 'indexProvider', label: 'Provider', type: 'string' },
    { id: 'methodology', label: 'Methodology', type: 'string' },
    { id: 'calcCurrency', label: 'Currency', type: 'string' },
    { id: 'mic', label: 'MIC', type: 'string' },
  ];
  for (const column of payload.columns) {
    columns.push({
      id: column.id,
      label: column.label,
      type: column.fmt === 'text' ? 'string' : column.fmt === 'datetime' ? 'datetime' : 'number',
      ...(column.decimals === undefined ? {} : { decimals: column.decimals }),
    });
  }
  columns.push(
    { id: 'sessionState', label: 'Session', type: 'string' },
    { id: 'sessionSource', label: 'Session source', type: 'string' },
    { id: 'localTime', label: 'Local time', type: 'datetime' },
    { id: 'historySessions', label: 'History sessions', type: 'number' },
    { id: 'state', label: 'State', type: 'string' },
  );
  return columns;
}

function weiCsvRows(payload: WeiPayload): (string | number | boolean | null)[][] {
  const rows: (string | number | boolean | null)[][] = [];
  for (const block of payload.regions) {
    for (const row of block.rows) {
      rows.push([
        block.region,
        row.code,
        row.key,
        row.name,
        row.indexProvider,
        row.methodology,
        row.calcCurrency,
        row.mic,
        ...payload.columns.map((c) => row.cells[c.id]?.v ?? null),
        row.sessionState,
        row.sessionSource,
        row.localTime,
        row.historySessions,
        worstCellState(row.cells),
      ]);
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const WEI = defineFunction<typeof WeiParams, WeiPayload>({
  code: 'WEI',
  name: 'World Equity Indices',
  aliases: ['INDICES'],
  tier: 1,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: WeiParams,
  paramGrammar: {
    positional: [{ name: 'regions', type: 'string', optional: true }],
    keyed: {
      CODES: { name: 'codes', type: 'string' },
      COLS: { name: 'columns', type: 'string' },
      VIEW: { name: 'view', type: 'enum', values: ['returns', 'levels'] },
      SORT: { name: 'sort', type: 'string' },
    },
  },
  fieldIds: (): FieldId[] => monitorPrecheckFields(WEI_PRECHECK_SUPERSET),
  pageable: false,
  // Half a second is enough for an index monitor and leaves the session's minimum conflation to
  // Q and QM when they are open (BUS-03).
  live: (_params, payload): LiveSpec =>
    monitorLive(
      payload.regions.flatMap((r) => r.rows),
      500,
    ),
  csv: {
    filename: (params, ctx): string => `WEI_${params.view}_${asOfCompact(ctx.asOf)}.csv`,
    columns: weiCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => weiCsvRows(payload),
  },
  help: {
    summary: 'Global index monitor by region with local-currency levels, returns and session state',
    description:
      'WEI is the morning screen: every seeded equity index on one page, grouped Americas / EMEA ' +
      '/ APAC, with the last level, the change on the day, period returns and the 52-week range. ' +
      "Values are in each index's own calculation currency and are never converted to USD — " +
      'compare currency-adjusted performance in GP with a currency overlay. S&P 500 and VIX come ' +
      'from Cboe’s delayed exchange feed, the Cboe UK 100 from Cboe Europe, the rest from the ' +
      'Yahoo chart endpoint; an index with no recorded quote shows a dotted pending cell until the ' +
      'scheduler polls it, never a stale number presented as live. Returns are simple ' +
      'close-to-close on price-adjusted history; an index without seeded daily history shows na ' +
      'with the reason. Session state comes from the venue calendar where one is seeded and from ' +
      "the provider's own status field otherwise. Enter opens DES, M the members of the index when " +
      'a membership source exists (S&P 500 only in v1).',
    params: [
      { name: 'regions', text: 'Americas, EMEA, APAC — comma separated', example: 'WEI EMEA' },
      { name: 'codes', text: 'explicit index codes', example: 'CODES=SPX,UKX,NKY' },
      { name: 'columns', text: 'field ids', example: 'COLS=PX_LAST,CHG_PCT_1D,RET_YTD' },
      { name: 'view', text: 'returns or levels', example: 'VIEW=LEVELS' },
      { name: 'sort', text: 'column:dir', example: 'SORT=CHG_PCT_1D:desc' },
    ],
    keys: [
      { key: 'Enter', action: 'DES for the focused index' },
      { key: 'M', action: 'members of the index, when a membership source exists' },
      { key: 'V', action: 'cycle returns / levels' },
      { key: 'R', action: 'cycle the regions shown' },
      { key: 'S', action: 'sort the focused column within every region' },
    ],
    sources: [
      'cboe.quotes',
      'cboe.euIndices',
      'yahoo.chart',
      'sec.archives',
      'ssga.holdings',
      'internal.derived',
    ],
    related: ['QM', 'MEMB', 'GP', 'GIP', 'DES', 'FXC'],
  },
  keymap: [
    {
      key: 'Enter',
      action: 'open-des',
      when: 'grid',
      description: 'Description of the focused index',
    },
    {
      key: 'Shift+Enter',
      action: 'open-des-next',
      when: 'grid',
      description: 'Description in the next panel',
    },
    { key: 'Q', action: 'open-q', when: 'grid', description: 'Quote of the focused index' },
    { key: 'P', action: 'open-gp', when: 'grid', description: 'Price chart of the focused index' },
    {
      key: 'I',
      action: 'open-gip',
      when: 'grid',
      description: 'Intraday chart of the focused index',
    },
    {
      key: 'M',
      action: 'open-memb',
      when: 'grid',
      description: 'Members of the index, when a membership source exists',
    },
    {
      key: 'Ctrl+I',
      action: 'cell-provenance',
      when: 'grid',
      description: 'Source, captured-at and request key of the focused cell (DATA-10)',
    },
    { key: 'V', action: 'cycle-view', description: 'Cycle returns / levels' },
    { key: 'R', action: 'cycle-regions', description: 'Cycle the regions shown' },
    { key: 'S', action: 'sort-column', when: 'grid', description: 'Sort the focused column' },
    { key: 'Shift+S', action: 'clear-sort', when: 'grid', description: 'Clear the sort' },
    { key: 'C', action: 'add-column', description: 'Add a dictionary field as a column (max 20)' },
    {
      key: 'Shift+C',
      action: 'remove-column',
      when: 'grid',
      description: 'Remove the focused column',
    },
    {
      key: 'W',
      action: 'save-as-watchlist',
      when: 'grid',
      description: 'Save the visible indices as a watchlist',
    },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default WEI;
