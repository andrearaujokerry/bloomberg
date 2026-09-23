// packages/core/src/functions/manifests/GP.ts
//
// GP — Price Graph (FUNCTIONS_TIER1.md §GP L381-550, FUNCTIONS.md §6 L1077).
//
// Seven variants, one per family of price history: `equity` (and `etf`, which charts identically),
// `index`, `fx`, `govt`, `option`, `crypto` and `series` (rates and economic observations). The
// asset-class → variant map is copied from the §6 table and may not be narrowed or widened here.
//
// `screenKind: 'custom'`: the ScreenSpec carries a `custom` node owning the chart canvas, so this
// manifest describes the *data* the canvas draws and nothing about how it is drawn.
//
// The payload types live in this file rather than beside the resolver because both sides need
// them: the server builds one and the web screen renders one, and a shape declared twice is a
// shape that drifts. `FnInstrumentSummary` is the API.md §3 `InstrumentSummary` restated over
// core's own `ResolvedRef` — `packages/core` may not import `@terminal/sdk` (it is below it in the
// graph, eslint.config.js L69), and the two declarations are structurally identical, so the
// server's `toSummary()` output assigns to it without a cast. GIP and HP import it from here.

import { z } from 'zod';

import { fromEpochDay } from '../../calendars/calendar.js';

import type { AssetClass, InstrumentStatus, ResolvedRef } from '../../types/instrument.js';
import type { FieldId } from '../../types/fields.js';
import type { PayloadAdjustment, ValueCell } from '../../types/function.js';
import type { CsvColumn, KeyBinding } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { AdjustPolicy, SecurityRefInput } from '../schemas.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared payload shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** API.md §3 `InstrumentSummary`, declared in core so a payload type can name it (see the header). */
export interface FnInstrumentSummary extends Omit<ResolvedRef, 'primaryListingId'> {
  /**
   * Restated with an explicit `| undefined`, which is why the base is `Omit`ted rather than
   * extended: the SDK's zod `InstrumentSummary` infers `primaryListingId?: number | undefined`
   * and core's `ResolvedRef` declares `primaryListingId?: number`. Under
   * `exactOptionalPropertyTypes` those two are not mutually assignable, and `toSummary()` — which
   * every resolver in this catalogue calls — produces the former.
   */
  primaryListingId?: number | undefined;
  ticker: string;
  exchCode: string;
  securityType: string;
  compositeFigi: string | null;
  status: InstrumentStatus;
  priceDecimals: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const GpRange = z.enum([
  '1D',
  '5D',
  '1M',
  '3M',
  '6M',
  'YTD',
  '1Y',
  '2Y',
  '5Y',
  '10Y',
  'MAX',
  'CUSTOM',
]);
export type GpRange = z.infer<typeof GpRange>;

export const GpPeriodicity = z.enum(['auto', '1m', '5m', 'D', 'W', 'M']);
export const GpSeriesPeriodicity = z.enum(['1m', '5m', 'D', 'W', 'M']);
export type GpSeriesPeriodicity = z.infer<typeof GpSeriesPeriodicity>;

export const GpChartType = z.enum([
  'line',
  'area',
  'mountain',
  'candle',
  'ohlc',
  'bar',
  'step',
  'pnf',
  'profile',
  'heatmap',
  'tick',
]);

export const GpParams = z.object({
  range: GpRange.default('1Y'),
  /** Used when `range === 'CUSTOM'`. */
  start: z.iso.date().optional(),
  end: z.iso.date().optional(),
  /** `auto`: 1D→1m, 5D→5m, ≤2Y→D, ≤10Y→W, MAX→M. */
  periodicity: GpPeriodicity.default('auto'),
  type: GpChartType.default('line'),
  adjust: AdjustPolicy.default('price'),
  overlays: z.array(SecurityRefInput).max(5).default([]),
  /** Forced to `'pct'` by the screen when overlays are present and this is `'none'`. */
  normalise: z.enum(['none', 'pct', 'base100']).default('none'),
  currency: z.string().length(3).optional(),
  studies: z
    .array(
      z.object({
        id: z.string().max(24),
        params: z.record(z.string(), z.number()).default({}),
        pane: z.enum(['main', 'sub']).default('sub'),
      }),
    )
    .max(8)
    .default([]),
  events: z
    .object({
      earnings: z.boolean().default(true),
      dividends: z.boolean().default(true),
      splits: z.boolean().default(true),
      news: z.boolean().default(false),
      filings: z.boolean().default(false),
      indexChanges: z.boolean().default(true),
      fomc: z.boolean().default(true),
    })
    // §GP writes `.default({})`; zod 4 types `.default()` against the schema's *output*, so the
    // same defaults are spelled out here. `events: { news: true }` still parses to the full object
    // because every key inside carries its own default.
    .default({
      earnings: true,
      dividends: true,
      splits: true,
      news: false,
      filings: false,
      indexChanges: true,
      fomc: true,
    }),
  logScale: z.boolean().default(false),
  volume: z.boolean().default(true),
});
export type GpParams = z.infer<typeof GpParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type GpVariant = 'equity' | 'index' | 'fx' | 'govt' | 'option' | 'crypto' | 'series';

/** The y-axis format hint; what the series *is*, not how it is drawn. */
export type GpUnit = 'price' | 'yield' | 'index' | 'pct' | 'rate';

export type GpEventKind =
  | 'earnings'
  | 'dividend'
  | 'split'
  | 'news'
  | 'filing'
  | 'index_add'
  | 'index_drop'
  | 'fomc';

export interface GpSeries {
  ref: z.infer<typeof SecurityRefInput>;
  /** `null` for a formula series (CHRT-07). */
  instrument: FnInstrumentSummary | null;
  formula: string | null;
  key: string;
  label: string;
  currency: string;
  calendarId: string;
  tz: string;
  unit: GpUnit;
  /** Epoch ms, bar start (UTC); ascending. */
  t: number[];
  /** `null` when the source carries no OHLC / no volume. */
  o: number[] | null;
  h: number[] | null;
  l: number[] | null;
  c: number[];
  v: number[] | null;
  adjust: z.infer<typeof AdjustPolicy>;
  periodicity: GpSeriesPeriodicity;
  /** Intraday only. */
  sessions: { start: number; end: number; kind: 'pre' | 'regular' | 'post' }[] | null;
  converted: { from: string; to: string } | null;
  provIdx: number;
  live: { subject: string; field: FieldId; mode: 'append-forming-bar' | 'replace-last' } | null;
}

export interface GpEvent {
  t: number;
  kind: GpEventKind;
  label: string;
  command: string;
  provIdx: number;
}

export interface GpAnnotation {
  annotationId: number;
  kind: 'trendline' | 'hline' | 'vline' | 'fib' | 'text' | 'regression_channel' | 'rect';
  anchors: { t: number; v: number }[];
  label: string | null;
  style: Record<string, unknown>;
  ownerUserId: number;
  sharedScope: 'private' | 'firm' | 'users';
  editable: boolean;
}

export interface GpPayload {
  variant: GpVariant;
  primary: GpSeries;
  overlays: GpSeries[];
  events: GpEvent[];
  annotations: GpAnnotation[];
  window: {
    start: string;
    end: string;
    range: GpRange;
    periodicity: GpSeriesPeriodicity;
    bars: number;
  };
  /** `PX_LAST` of the primary — the crosshair default, and a live cell in the header. */
  last: ValueCell;
  /**
   * Horizontal reference lines. Each carries its own `provIdx` so `Ctrl+I` answers for a line the
   * same way it answers for a cell — a reference line is a displayed price like any other
   * (FUNCTIONS.md §1.5, DATA-10).
   *
   * `'last yield'` rather than `'par'`: the value is the last close of the instrument's own yield
   * series, which is what the series carries. A par yield is a different quantity, derived from the
   * curve, and the label may not claim more than the number is.
   */
  reference: { label: 'prev close' | 'last yield' | 'strike'; v: number; provIdx: number }[];
  /** Also in `meta`; repeated so the toolbar can badge them without reading `meta`. */
  adjustments: PayloadAdjustment[];
  fx: { base: string; quote: string; points: [number, number][]; provIdx: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlement pre-check field sets (FUNCTIONS_TIER1 §GP "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PRICE_FIELDS: readonly FieldId[] = [
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_LAST',
  'PX_VOLUME',
  'PX_CLOSE_1D',
  'LAST_TRADE_TIME',
  'BAR_TS',
  'IS_FINAL',
  'TOT_RETURN_INDEX',
  'HEADLINE',
];

/**
 * §GP writes `CRV_1M` here. No such id exists in `core/fields/dictionary.ts` (the curve fields are
 * `CURVE_PAR`, `CURVE_ZERO`, `CURVE_DF`, `CURVE_FWD_3M`), and manifest invariant 4 requires every
 * id returned here to be in the dictionary — so the par-yield read is declared as what it is.
 */
const GOVT_FIELDS: readonly FieldId[] = ['CURVE_PAR', 'YLD_YTM_MID', 'BEY'];
const RATE_FIELDS: readonly FieldId[] = ['RATE'];
const ECON_FIELDS: readonly FieldId[] = ['ECO_VALUE', 'ECO_VINTAGE'];

function fieldsFor(assetClass: AssetClass | null): FieldId[] {
  if (assetClass === 'govt') return [...GOVT_FIELDS];
  if (assetClass === 'rate') return [...RATE_FIELDS];
  if (assetClass === 'econ') return [...ECON_FIELDS];
  return [...PRICE_FIELDS];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One table, one row per `(bar, series)` in series order, then the event markers as rows whose
 * `series` is `'event'` (FUNCTIONS.md §1.6 rule 3 — a CSV is never two tables). Annotations are
 * user drawings and studies are deterministic client-side transforms of these very closes; neither
 * is exported.
 */
export const gpCsvColumns: readonly CsvColumn[] = [
  { id: 't', label: 'Timestamp', type: 'string' },
  { id: 'series', label: 'Series', type: 'string' },
  { id: 'open', label: 'Open', type: 'number' },
  { id: 'high', label: 'High', type: 'number' },
  { id: 'low', label: 'Low', type: 'number' },
  { id: 'close', label: 'Close', type: 'number' },
  { id: 'volume', label: 'Volume', type: 'number' },
  { id: 'currency', label: 'Currency', type: 'string' },
  { id: 'adjust', label: 'Adjust', type: 'string' },
];

const MS_PER_DAY = 86_400_000;

/**
 * `2026-09-15T13:30:00Z` from epoch milliseconds, without `Date`.
 *
 * `packages/core` has no ambient clock and no `Date` (ARCHITECTURE L49, enforced by
 * `no-restricted-globals`), and `new Date(ms).toISOString()` would be reading the platform's
 * calendar implementation rather than computing one. `fromEpochDay` is the same civil-date
 * arithmetic the calendars use, so a timestamp printed in a CSV and a session date computed by a
 * calendar cannot disagree about which day an instant falls on.
 */
export function isoFromEpochMs(ms: number): string {
  const day = Math.floor(ms / MS_PER_DAY);
  const rest = ms - day * MS_PER_DAY;
  const seconds = Math.floor(rest / 1000);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${fromEpochDay(day)}T${pad(hh)}:${pad(mm)}:${pad(ss)}Z`;
}

/** `YYYY-MM-DD` for D/W/M, ISO-8601 UTC for the intraday periodicities. */
export function gpCsvTimestamp(ms: number, periodicity: GpSeriesPeriodicity): string {
  const iso = isoFromEpochMs(ms);
  return periodicity === '1m' || periodicity === '5m' ? iso : iso.slice(0, 10);
}

function seriesRows(series: GpSeries): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  for (const [i, t] of series.t.entries()) {
    rows.push([
      gpCsvTimestamp(t, series.periodicity),
      series.key,
      series.o?.[i] ?? null,
      series.h?.[i] ?? null,
      series.l?.[i] ?? null,
      series.c[i] ?? null,
      series.v?.[i] ?? null,
      series.currency,
      series.adjust,
    ]);
  }
  return rows;
}

export function gpCsvRows(payload: GpPayload): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  for (const series of [payload.primary, ...payload.overlays]) rows.push(...seriesRows(series));
  for (const event of payload.events) {
    rows.push([
      gpCsvTimestamp(event.t, payload.window.periodicity),
      'event',
      event.kind,
      event.label,
      event.command,
      null,
      null,
      null,
      null,
    ]);
  }
  return rows;
}

/** `GP_AAPL_US_Equity_1Y_20260915T184128Z.csv` (§GP CSV). */
export function slugOf(display: string | null): string {
  return (display ?? 'series').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** `2026-09-15T18:41:28.000Z` → `20260915T184128Z` (API.md §9). */
export function asOfCompact(asOf: string): string {
  return asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keymap
//
// §2.6's reserved keys may not be bound by a function keymap (manifest invariant 3), so the four
// rows §GP lists for `Enter`, `Delete`… are split: `Enter` (GO) and `Ctrl+I` (provenance) stay
// with the shell and the chart node handles them through its own `custom` key handling, while
// `Delete` and `Ctrl+S` are bindable and are here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const KEYMAP: readonly KeyBinding[] = [
  { key: 'ArrowLeft', action: 'crosshair-prev', when: 'chart', description: 'Crosshair one bar left' },
  { key: 'ArrowRight', action: 'crosshair-next', when: 'chart', description: 'Crosshair one bar right' },
  { key: 'Shift+ArrowLeft', action: 'pan-left', when: 'chart', description: 'Pan left 10%' },
  { key: 'Shift+ArrowRight', action: 'pan-right', when: 'chart', description: 'Pan right 10%' },
  { key: '+', action: 'zoom-in', when: 'chart', description: 'Zoom in around the crosshair' },
  { key: '-', action: 'zoom-out', when: 'chart', description: 'Zoom out around the crosshair' },
  { key: 'Home', action: 'crosshair-first', when: 'chart', description: 'Crosshair to the first bar' },
  { key: 'End', action: 'crosshair-last', when: 'chart', description: 'Crosshair to the last bar' },
  { key: 'R', action: 'cycle-range', description: 'Next range' },
  { key: 'Shift+R', action: 'custom-range', description: 'Prompt for a custom start and end' },
  { key: 'T', action: 'cycle-type', description: 'Next chart type' },
  { key: 'A', action: 'cycle-adjust', description: 'Next adjustment basis' },
  { key: 'L', action: 'toggle-log', description: 'Toggle the log y-axis' },
  { key: 'N', action: 'cycle-normalise', description: 'Next normalisation' },
  { key: 'P', action: 'cycle-periodicity', description: 'Next periodicity allowed for the range' },
  { key: 'V', action: 'toggle-volume', description: 'Toggle the volume pane' },
  { key: 'O', action: 'add-overlay', description: 'Add an overlay security (max 5)' },
  { key: 'X', action: 'remove-overlay', description: 'Remove the last overlay' },
  { key: 'C', action: 'set-currency', description: 'Convert to a currency' },
  { key: 'S', action: 'add-study', description: 'Add a study' },
  { key: 'Shift+S', action: 'remove-study', description: 'Remove the last study' },
  { key: 'E', action: 'toggle-events', description: 'Toggle every event marker kind' },
  { key: 'D', action: 'draw-mode', when: 'chart', description: 'Cycle the drawing tool' },
  { key: 'Delete', action: 'delete-annotation', when: 'chart', description: 'Delete the focused annotation' },
  { key: 'Ctrl+S', action: 'save-annotations', description: 'Persist pending annotation edits' },
  { key: 'G', action: 'open-gip', description: 'Open GIP' },
  { key: 'H', action: 'open-hp', description: 'Open HP over the same window' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const GP = defineFunction<typeof GpParams, GpPayload>({
  code: 'GP',
  name: 'Price Graph',
  aliases: ['GRAPH', 'CHART'],
  tier: 1,
  category: 'charting',
  assetClasses: ['equity', 'etf', 'index', 'fx', 'govt', 'option', 'crypto', 'rate', 'econ'],
  requiresSecurity: true,
  variants: {
    equity: 'equity',
    etf: 'equity',
    index: 'index',
    fx: 'fx',
    govt: 'govt',
    option: 'option',
    crypto: 'crypto',
    rate: 'series',
    econ: 'series',
  },
  params: GpParams,
  paramGrammar: {
    positional: [
      { name: 'range', type: 'range', optional: true },
      { name: 'start', type: 'date', optional: true },
      { name: 'end', type: 'date', optional: true },
    ],
    keyed: {
      TYPE: { name: 'type', type: 'enum', values: GpChartType.options },
      ADJ: { name: 'adjust', type: 'enum', values: AdjustPolicy.options },
      VS: { name: 'overlays', type: 'security' },
      CCY: { name: 'currency', type: 'currency' },
      NORM: { name: 'normalise', type: 'enum', values: ['none', 'pct', 'base100'] },
      PER: { name: 'periodicity', type: 'enum', values: GpPeriodicity.options },
      LOG: { name: 'logScale', type: 'boolean' },
    },
  },
  fieldIds: fieldsFor,
  pageable: false,
  live: (params, payload) => {
    const subjects = [payload.primary, ...payload.overlays]
      .map((s) => s.live?.subject)
      .filter((s): s is string => s !== undefined);
    if (subjects.length === 0) return null;
    const intraday =
      payload.window.periodicity === '1m' || payload.window.periodicity === '5m';
    return {
      subjects,
      fields: intraday
        ? ['BAR_TS', 'PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME', 'IS_FINAL']
        : ['PX_LAST', 'PX_VOLUME', 'LAST_TRADE_TIME', 'PX_CLOSE_1D'],
      conflationMs: 500,
    };
  },
  csv: {
    filename: (params, ctx) =>
      `GP_${slugOf(ctx.display)}_${params.range}_${asOfCompact(ctx.asOf)}.csv`,
    // A function, not the array: `FunctionManifestPublic.csvColumns` is `null` for GP because the
    // rows are payload-shaped (one block per series plus the event rows), so a client may not
    // assume the column list describes a single homogeneous table.
    columns: () => [...gpCsvColumns],
    rows: (payload) => gpCsvRows(payload),
  },
  help: {
    summary: 'Price chart from intraday to multi-decade with overlays, events, studies and annotations',
    description:
      'GP charts the loaded security. Ranges 1D and 5D use 1- and 5-minute bars; longer ranges ' +
      'use daily bars resampled to weekly or monthly. Corporate actions are applied on read under ' +
      'the adjust policy shown in the toolbar (price: splits and capital changes; total_return: ' +
      'also cash dividends; unadjusted: raw closes); the factors used are listed in the footer.\n\n' +
      'Overlays (VS=) are aligned on each security’s own calendar and normalised to percent ' +
      'change or base 100 when their units differ; a formula such as <RATIO(AAPL US Equity, SPX ' +
      'Index)> can be charted or overlaid.\n\n' +
      'Event markers come from SEC filings, corporate actions, index membership changes and FOMC ' +
      'dates; Enter on a marker opens its source function. Studies are computed in the client from ' +
      'the exported data. Annotations are saved server-side and can be shared with the firm.\n\n' +
      'Treasuries chart the on-the-run tenor’s yield; rates and economic series chart the ' +
      'published observations as known at the knownAt in the footer.',
    params: [
      { name: 'range', text: '1D 5D 1M 3M 6M YTD 1Y 2Y 5Y 10Y MAX, or two dates', example: '5Y' },
      { name: 'start', text: 'Custom window start', example: '2020-01-01' },
      { name: 'end', text: 'Custom window end', example: '2020-12-31' },
      { name: 'periodicity', text: 'auto, 1m, 5m, D, W, M', example: 'PER=W' },
      {
        name: 'type',
        text: 'line, area, mountain, candle, ohlc, bar, step, pnf, profile, heatmap, tick',
        example: 'TYPE=CANDLE',
      },
      { name: 'adjust', text: 'price, total_return, unadjusted', example: 'ADJ=TR' },
      { name: 'overlays', text: 'Up to five VS= securities or formulas', example: 'VS=MSFT US Equity' },
      { name: 'normalise', text: 'none, pct, base100', example: 'NORM=BASE100' },
      { name: 'currency', text: 'Convert with ECB reference rates', example: 'CCY=EUR' },
      { name: 'studies', text: 'Technical studies, S to add', example: 'SMA 50' },
      { name: 'events', text: 'Marker kinds', example: 'E toggles' },
      { name: 'logScale', text: 'Log y-axis', example: 'LOG=1' },
      { name: 'volume', text: 'Volume pane', example: 'V toggles' },
    ],
    keys: KEYMAP.map((k) => ({ key: k.key, action: k.description })),
    sources: [
      'yahoo.chart',
      'cboe.quotes',
      'frankfurter',
      'sec.submissions',
      'sec.atom',
      'sec.archives',
      'ssga.holdings',
      'fed.fomc',
      'treasury.yieldcurve',
      'treasury.bills',
      'nyfed.rates',
      'fred.csv',
      'bls.timeseries',
      'cboe.options',
      'coingecko.simple',
      'internal.derived',
    ],
    related: ['GIP', 'HP', 'DES', 'CACS', 'CN', 'GC'],
  },
  keymap: KEYMAP,
  screenKind: 'custom',
  payloadVersion: 1,
});
