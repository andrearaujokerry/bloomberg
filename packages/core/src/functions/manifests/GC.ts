// packages/core/src/functions/manifests/GC.ts
//
// `GC` — Benchmark Curve Chart (FUNCTIONS_TIER3.md §GC L1563-1734, FUNCTIONS.md §6).
//
// GC is the *time* view of the curves CRVF constructs. `mode:'curve'` draws the benchmark curve on
// one date against up to four earlier dates and tabulates the basis-point change at every tenor
// plus the slope spreads (2s10s, 5s30s, 3M10Y); `mode:'history'` draws selected tenors and those
// spreads as daily series over a range. It never bootstraps a curve of its own — it reads the same
// `curve_points` rows and the same `curve_builds` cache CRVF writes (ANAL-08) — and for long
// history it reads stored `econ_observations` rather than inventing points between curve dates.
//
// `SOFR_FIX` is not offered: it has no term structure (CRVF's `FIXING_ONLY_NO_TERM_STRUCTURE`), so
// it is absent from the enum and a typed `SOFR_FIX` is a `VALIDATION_FAILED` on `curveId` rather
// than an empty chart. `SOFR_OIS` carries the `PROXY_CURVE` caveat wherever it appears.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§GC "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const GC_CURVE_IDS = ['UST_PAR', 'UST_CMT', 'UST_BILL', 'SOFR_OIS'] as const;
export type GcCurveId = (typeof GC_CURVE_IDS)[number];

/** The relative comparison tokens `CMP=` accepts beside a literal date. */
export const GC_COMPARE_TOKENS = ['PREV', '1W', '1M', '3M', 'YTD', '1Y'] as const;
export type GcCompareToken = (typeof GC_COMPARE_TOKENS)[number];

export const GC_TENORS = [
  '1M',
  '3M',
  '6M',
  '1Y',
  '2Y',
  '3Y',
  '5Y',
  '7Y',
  '10Y',
  '20Y',
  '30Y',
] as const;
export type GcTenor = (typeof GC_TENORS)[number];

export const GC_SPREADS = ['2s10s', '5s30s', '3M10Y'] as const;
export type GcSpreadId = (typeof GC_SPREADS)[number];

/** Each slope spread as `long − short`, in basis points. */
export const GC_SPREAD_LEGS: Readonly<Record<GcSpreadId, readonly [GcTenor, GcTenor]>> =
  Object.freeze({
    '2s10s': ['2Y', '10Y'],
    '5s30s': ['5Y', '30Y'],
    '3M10Y': ['3M', '10Y'],
  });

export const GcParams = z.object({
  curveId: z.enum(GC_CURVE_IDS).default('UST_PAR'),
  mode: z.enum(['curve', 'history']).default('curve'),
  /** `null` = the latest stored `curve_date ≤ validAt`. */
  date: z.iso.date().nullable().default(null),
  compare: z
    .array(z.union([z.iso.date(), z.enum(GC_COMPARE_TOKENS)]))
    .max(4)
    .default(['PREV', '1W', '1M']),
  tenors: z
    .array(z.enum(GC_TENORS))
    .min(1)
    .max(6)
    .default(['2Y', '10Y', '30Y']),
  /** History mode only. */
  range: z.enum(['1M', '3M', '6M', '1Y', '5Y', 'MAX']).default('1Y'),
  spreads: z.array(z.enum(GC_SPREADS)).max(3).default(['2s10s']),
  view: z.enum(['both', 'chart', 'table']).default('both'),
});
export type GcParams = z.infer<typeof GcParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§GC "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type GcCaveat = 'PROXY_CURVE' | 'CURVE_DATES_ONLY' | 'NO_LONG_HISTORY_FOR_TENOR';

export interface GcCurveBlock {
  id: GcCurveId;
  name: string;
  currency: string;
  kind: string;
  dayCount: string;
  compounding: string;
  sourceId: string;
  provIdx: number;
  date: string;
  requestedDate: string | null;
  availableDates: string[];
}

export interface GcSnapshotPoint {
  tenor: string;
  tenorDays: number;
  quoteType: string;
  value: ValueCell;
}

export interface GcSnapshot {
  /** `'CUR'`, `'PREV'`, `'1W'`, … or `'D:2026-09-08'` for a literal date. */
  id: string;
  /** `'09-14'` — the chart legend label. */
  label: string;
  /** What was asked for: the token, or the literal date. */
  requested: string;
  date: string;
  /** `null` when no build exists — GC never bootstraps for a comparison date. */
  buildId: number | null;
  provIdx: number;
  points: GcSnapshotPoint[];
}

export interface GcVsEntry {
  id: string;
  label: string;
  date: string;
  bp: ValueCell;
}

export interface GcChange {
  tenor: string;
  tenorDays: number;
  current: ValueCell;
  vs: GcVsEntry[];
}

export interface GcSpreadRow {
  id: GcSpreadId;
  label: string;
  legs: [string, string];
  current: ValueCell;
  vs: GcVsEntry[];
}

export interface GcObservation {
  d: string;
  v: number | null;
}

export interface GcHistorySeries {
  tenor: string;
  source: 'econ_series' | 'curve_points' | 'rate_fixings';
  seriesCode: string | null;
  sourceId: string;
  provIdx: number;
  unit: 'pct';
  obs: GcObservation[];
  coverage: { first: string | null; last: string | null; n: number };
  truncated: boolean;
}

export interface GcSpreadSeries {
  id: GcSpreadId;
  label: string;
  legs: [string, string];
  unit: 'bp';
  obs: GcObservation[];
}

export interface GcHistory {
  range: GcParams['range'];
  from: string;
  to: string;
  series: GcHistorySeries[];
  spreadSeries: GcSpreadSeries[];
}

export interface GcPayload {
  variant: 'default';
  mode: 'curve' | 'history';
  curve: GcCurveBlock;
  snapshots: GcSnapshot[];
  changes: GcChange[];
  spreads: GcSpreadRow[];
  /** `null` in curve mode. */
  history: GcHistory | null;
  caveats: GcCaveat[];
  /** `ctx.asOf.validAt`. */
  asOf: string;
}

/** Footer text for the badge a dropped comparison raises. */
export const GC_CURVE_DATES_ONLY_DETAIL =
  'this build stores a handful of curve dates, so a relative comparison resolves to the earliest ' +
  'stored date or is dropped with a reason';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tenor → stored history series (§GC's map)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The long-history series behind a tenor, when one is stored.
 *
 * §GC places this map in `packages/server/src/functions/GC/seriesMap.ts`. It lives here instead:
 * it is a *catalogue* fact (which `econ_series.series_code` a curve tenor is published as), the
 * screen legend needs it as much as the resolver does, and `packages/core` is the one place both
 * sides already import. The resolver reads it; nothing else changes.
 */
export const GC_SERIES_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    UST_PAR: Object.freeze({
      '1M': 'H15_RIFLGFCM01',
      '3M': 'H15_RIFLGFCM03',
      '6M': 'H15_RIFLGFCM06',
      '1Y': 'H15_RIFLGFCY01',
      '2Y': 'H15_RIFLGFCY02',
      '3Y': 'H15_RIFLGFCY03',
      '5Y': 'H15_RIFLGFCY05',
      '7Y': 'H15_RIFLGFCY07',
      '10Y': 'DGS10',
      '20Y': 'H15_RIFLGFCY20',
      '30Y': 'H15_RIFLGFCY30',
    }),
    UST_CMT: Object.freeze({
      '1M': 'H15_RIFLGFCM01',
      '3M': 'H15_RIFLGFCM03',
      '6M': 'H15_RIFLGFCM06',
      '1Y': 'H15_RIFLGFCY01',
      '2Y': 'H15_RIFLGFCY02',
      '3Y': 'H15_RIFLGFCY03',
      '5Y': 'H15_RIFLGFCY05',
      '7Y': 'H15_RIFLGFCY07',
      '10Y': 'DGS10',
      '20Y': 'H15_RIFLGFCY20',
      '30Y': 'H15_RIFLGFCY30',
    }),
    UST_BILL: Object.freeze({}),
    SOFR_OIS: Object.freeze({}),
  });

/** The `rate_fixings.rate_code` behind a tenor, when the tenor *is* a fixing. */
export const GC_FIXING_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    SOFR_OIS: Object.freeze({ ON: 'SOFR' }),
  });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§GC "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const GC_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'CRV_1M',
  'CRV_3M',
  'CRV_6M',
  'CRV_1Y',
  'CRV_2Y',
  'CRV_3Y',
  'CRV_5Y',
  'CRV_7Y',
  'CRV_10Y',
  'CRV_20Y',
  'CRV_30Y',
  'CURVE_PAR',
  'ECO_VALUE',
  'ECO_PERIOD',
  'ECO_VINTAGE',
  'SPREAD',
] as const);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§GC "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const GC_CSV_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'label', label: 'Label', type: 'string' },
  { id: 'date', label: 'Date', type: 'date' },
  { id: 'tenor', label: 'Tenor', type: 'string' },
  { id: 'days', label: 'Days', type: 'number' },
  { id: 'value', label: 'Value', type: 'number' },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'source', label: 'Source', type: 'string' },
];

type CsvRow = (string | number | boolean | null)[];

const numberOr = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

function gcCsvRows(payload: GcPayload): CsvRow[] {
  const rows: CsvRow[] = [];
  const source = payload.curve.sourceId;
  for (const snapshot of payload.snapshots) {
    for (const point of snapshot.points) {
      rows.push([
        'snapshot',
        snapshot.label,
        snapshot.date,
        point.tenor,
        point.tenorDays,
        numberOr(point.value),
        'pct',
        source,
      ]);
    }
  }
  for (const change of payload.changes) {
    for (const vs of change.vs) {
      rows.push([
        'change',
        vs.label,
        vs.date,
        change.tenor,
        change.tenorDays,
        numberOr(vs.bp),
        'bp',
        'internal.derived',
      ]);
    }
  }
  for (const spread of payload.spreads) {
    rows.push([
      'spread',
      'current',
      payload.curve.date,
      spread.id,
      null,
      numberOr(spread.current),
      'bp',
      'internal.derived',
    ]);
    for (const vs of spread.vs) {
      rows.push([
        'spread',
        vs.label,
        vs.date,
        spread.id,
        null,
        numberOr(vs.bp),
        'bp',
        'internal.derived',
      ]);
    }
  }
  if (payload.history !== null) {
    for (const series of payload.history.series) {
      for (const obs of series.obs) {
        rows.push(['history', series.tenor, obs.d, series.tenor, null, obs.v, 'pct', series.sourceId]);
      }
    }
    for (const series of payload.history.spreadSeries) {
      for (const obs of series.obs) {
        rows.push([
          'history_spread',
          series.label,
          obs.d,
          series.id,
          null,
          obs.v,
          'bp',
          'internal.derived',
        ]);
      }
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const GC = defineFunction<typeof GcParams, GcPayload>({
  code: 'GC',
  name: 'Benchmark Curve Chart',
  aliases: ['GCRV'],
  tier: 3,
  category: 'charting',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: GcParams,
  paramGrammar: {
    positional: [
      { name: 'curveId', type: 'curve', optional: true },
      { name: 'date', type: 'date', optional: true },
    ],
    keyed: {
      CMP: { name: 'compare', type: 'string' },
      TNR: { name: 'tenors', type: 'string' },
      R: { name: 'range', type: 'enum', values: ['1M', '3M', '6M', '1Y', '5Y', 'MAX'] },
      SPD: { name: 'spreads', type: 'string' },
      MODE: { name: 'mode', type: 'enum', values: ['curve', 'history'] },
    },
  },
  fieldIds: (): FieldId[] => [...GC_FIELD_IDS],
  pageable: false,
  live: (params): LiveSpec => ({
    subjects: [`c:${params.curveId}`],
    fields: '*',
    conflationMs: 1000,
  }),
  csv: {
    filename: (params, ctx): string =>
      `GC_${params.curveId}_${params.mode}_${(params.date ?? ctx.asOf.slice(0, 10)).replace(/-/g, '')}.csv`,
    columns: GC_CSV_COLUMNS,
    rows: (payload): CsvRow[] => gcCsvRows(payload),
  },
  help: {
    summary: 'Benchmark Treasury/CMT/SOFR curve across dates, with tenor history',
    description:
      'GC plots a stored benchmark curve for one date against up to four earlier dates and ' +
      'tabulates the basis-point change at every tenor, or switches to history mode and plots ' +
      'selected tenors and tenor spreads (2s10s, 5s30s, 3M10Y) as daily series. The offline build ' +
      'stores a handful of Treasury curve dates, so relative comparisons such as 1M or YTD ' +
      'resolve to the earliest stored date and say so; long tenor history comes from the stored ' +
      'FRED and H.15 series, and any tenor without a stored series is left blank with a reason ' +
      'rather than interpolated. Use CRVF for how a curve is built, YAS to price the on-the-run ' +
      'issue at a tenor, and FED for the policy rates underneath the front end.',
    params: [
      { name: 'curveId', text: 'UST_PAR, UST_CMT, UST_BILL or SOFR_OIS', example: 'UST_CMT' },
      { name: 'mode', text: 'curve or history' },
      { name: 'date', text: 'curve date; default latest', example: '2026-09-11' },
      { name: 'compare', text: 'dates or PREV/1W/1M/3M/YTD/1Y', example: 'CMP=PREV' },
      { name: 'tenors', text: 'history tenors', example: 'TNR=2Y,10Y,30Y' },
      { name: 'range', text: 'history range', example: 'R=5Y' },
      { name: 'spreads', text: '2s10s, 5s30s, 3M10Y' },
      { name: 'view', text: 'both, chart or table' },
    ],
    keys: [
      { key: 'M', action: 'switch curve / history' },
      { key: 'K', action: 'cycle the curve' },
      { key: 'C', action: 'add a comparison date' },
      { key: 'R', action: 'cycle the history range' },
      { key: 'B', action: 'open CRVF for the build detail' },
    ],
    sources: [
      'treasury.yieldcurve',
      'treasury.bills',
      'fed.h15',
      'nyfed.rates',
      'fred.csv',
      'internal.derived',
    ],
    related: ['CRVF', 'YAS', 'FED', 'BTMM', 'WIRP'],
  },
  keymap: [
    { key: 'M', action: 'cycle-mode', description: 'Switch curve / history' },
    { key: 'K', action: 'cycle-curve', description: 'Cycle the curve' },
    { key: 'D', action: 'date-prompt', description: 'Prompt for a curve date' },
    {
      key: 'ArrowLeft',
      action: 'prev-date',
      when: 'chart',
      description: 'Previous stored curve date',
    },
    { key: 'ArrowRight', action: 'next-date', when: 'chart', description: 'Next stored curve date' },
    { key: 'C', action: 'add-compare', description: 'Add a comparison (date or PREV/1W/1M/3M/YTD/1Y)' },
    { key: 'X', action: 'clear-compare', description: 'Clear the comparisons' },
    { key: 'R', action: 'cycle-range', description: 'Cycle the history range' },
    { key: 'T', action: 'tenor-prompt', description: 'Prompt for the history tenors' },
    { key: 'S', action: 'cycle-spreads', description: 'Cycle the slope spreads' },
    { key: 'V', action: 'cycle-view', description: 'Cycle both / chart / table' },
    {
      key: 'Enter',
      action: 'row-provenance',
      when: 'grid',
      description: 'Provenance of the focused snapshot cell',
    },
    {
      key: 'Shift+Enter',
      action: 'open-yas-next',
      when: 'grid',
      description: 'Price the on-the-run issue of the focused tenor',
    },
    { key: 'B', action: 'open-crvf', description: 'Curve construction for this date' },
    { key: 'F', action: 'open-fed', description: 'Fed monitor' },
  ],
  screenKind: 'custom',
  payloadVersion: 1,
});

export default GC;
