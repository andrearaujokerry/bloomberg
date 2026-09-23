// packages/core/src/functions/manifests/HP.ts
//
// HP — Historical Price Table (FUNCTIONS_TIER1.md §HP L658-770, FUNCTIONS.md §6 L1079).
//
// Two variants: `price` for anything with a daily bar (equity, etf, index, fx, crypto) and
// `series` for the three published-observation families (govt curve history, rate fixings,
// economic observations). Pageable, `declarative`, and deliberately **not live**: HP shows
// completed sessions only, so the CSV equals the screen exactly (FUNC-03). The open session is
// signalled by `sessionOpen` and the §0.4.6 footer note, never by a half-finished row.
//
// The adjustment basis is the substance of this function. `bars_daily` is always the unadjusted
// print; the factors are computed from `corporate_actions` **as of `ctx.asOf`**, so the same
// window read at two `knownAt` instants legitimately returns two different price series — which
// is what API.md §12.1's second request demonstrates and what `HP.test.ts` reproduces.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { AssetClass } from '../../types/instrument.js';
import type { CsvColumn, KeyBinding } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { requireField } from '../../fields/dictionary.js';
import { decimalsOf, formatOf } from '../../fields/format.js';
import type { FieldFormat } from '../../fields/format.js';
import { AdjustPolicy, Periodicity } from '../schemas.js';
import type { FnInstrumentSummary } from './GP.js';
import { asOfCompact, slugOf } from './GP.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const HpRange = z.enum(['1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', '10Y', 'MAX', 'CUSTOM']);
export type HpRange = z.infer<typeof HpRange>;

/** The price fields a column may be chosen from (§HP Params). */
export const HpField = z.enum([
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_LAST',
  'PX_VOLUME',
  'VWAP',
  'PX_OFFICIAL_CLOSE',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'TOT_RETURN_INDEX',
]);
export type HpField = z.infer<typeof HpField>;

export const HP_DEFAULT_FIELDS: readonly HpField[] = [
  'PX_LAST',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_VOLUME',
  'CHG_PCT_1D',
];

export const HpParams = z.object({
  range: HpRange.default('1Y'),
  start: z.iso.date().optional(),
  end: z.iso.date().optional(),
  periodicity: Periodicity.default('D'),
  adjust: AdjustPolicy.default('price'),
  currency: z.string().length(3).optional(),
  fields: z.array(HpField).min(1).max(10).default([...HP_DEFAULT_FIELDS]),
  order: z.enum(['desc', 'asc']).default('desc'),
  pageSize: z.number().int().min(20).max(500).default(60),
});
export type HpParams = z.infer<typeof HpParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface HpColumn {
  id: FieldId;
  label: string;
  fmt: FieldFormat;
  decimals: number | null;
}

export interface HpPriceRow {
  date: string;
  /** One value per `columns[]`, in order; `null` is "no value for this session", never zero. */
  v: (number | null)[];
  /** The cumulative price factor applied to this row (1 when none), and its volume twin. */
  adjFactor: number;
  volumeFactor: number;
  /** Bars aggregated into the row — 1 for `D`. */
  sessions: number;
}

export interface HpSummary {
  first: number | null;
  last: number | null;
  high: number | null;
  highDate: string | null;
  low: number | null;
  lowDate: string | null;
  priceReturnPct: number | null;
  totalReturnPct: number | null;
  avgVolume: number | null;
  bars: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface HpPricePayload {
  variant: 'price';
  instrument: FnInstrumentSummary;
  columns: HpColumn[];
  rows: HpPriceRow[];
  /** Over the whole window, not the page — identical on every page. */
  summary: HpSummary;
  window: { start: string; end: string; range: HpRange };
  periodicity: z.infer<typeof Periodicity>;
  adjust: z.infer<typeof AdjustPolicy>;
  currency: string;
  converted: { from: string; to: string } | null;
  calendarId: string;
  /** `plant.snapshot('q:<id>')?.session === 'open'` — the §0.4.6 footer note's trigger. */
  sessionOpen: boolean;
  provIdx: number[];
}

export interface HpSeriesRow {
  date: string;
  v: (number | null)[];
  status: 'final' | 'preliminary' | 'revised' | 'missing' | null;
  vintageAt: string | null;
  chgAbs: number | null;
  chgPct: number | null;
}

export interface HpSeriesSummary {
  first: number | null;
  last: number | null;
  high: number | null;
  highDate: string | null;
  low: number | null;
  lowDate: string | null;
  changeAbs: number | null;
  changePct: number | null;
  observations: number;
}

export interface HpSeriesPayload {
  variant: 'series';
  instrument: FnInstrumentSummary;
  series: {
    kind: 'govt' | 'rate' | 'econ';
    code: string;
    name: string;
    units: string;
    frequency: 'D' | 'W' | 'M' | 'Q' | 'A';
    sourceId: string;
    curveId: string | null;
    tenor: string | null;
  };
  columns: HpColumn[];
  rows: HpSeriesRow[];
  summary: HpSeriesSummary;
  window: { start: string; end: string; range: HpRange };
  periodicity: z.infer<typeof Periodicity>;
  knownAt: string;
  provIdx: number[];
}

export type HpPayload = HpPricePayload | HpSeriesPayload;

/** The column a dictionary field implies — label, rendering and decimals all from the dictionary. */
export function hpColumn(id: FieldId): HpColumn {
  return { id, label: requireField(id).label, fmt: formatOf(id), decimals: decimalsOf(id) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlement pre-check field sets (§HP "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PRICE_FIELDS: readonly FieldId[] = [...HpField.options];

/**
 * §HP writes `CRV_1M` for the govt par-yield column. The dictionary has no such id (invariant 4
 * requires every id here to be in it), and the curve fields it *does* have are `CURVE_PAR`,
 * `CURVE_ZERO`, `CURVE_DF` and `CURVE_FWD_3M`; the par-yield read is declared as `CURVE_PAR`.
 */
const GOVT_FIELDS: readonly FieldId[] = ['CURVE_PAR', 'DISC_RATE', 'BEY'];
const RATE_FIELDS: readonly FieldId[] = [
  'RATE',
  'RATE_P1',
  'RATE_P25',
  'RATE_P75',
  'RATE_P99',
  'RATE_VOLUME_BN',
];
const ECON_FIELDS: readonly FieldId[] = ['ECO_VALUE', 'ECO_VINTAGE'];

function fieldsFor(assetClass: AssetClass | null): FieldId[] {
  if (assetClass === 'govt') return [...GOVT_FIELDS];
  if (assetClass === 'rate') return [...RATE_FIELDS];
  if (assetClass === 'econ') return [...ECON_FIELDS];
  return [...PRICE_FIELDS];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV
//
// Payload-dependent: the columns are the payload's own columns (which follow `params.fields` for
// the price variant and the series kind for the other), plus the trailing bookkeeping columns.
// The rows are the payload's rows — the CSV *is* the table on screen (FUNC-03), cell for cell.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function hpCsvColumns(payload: HpPayload): CsvColumn[] {
  const head: CsvColumn = { id: 'date', label: 'Date', type: 'date' };
  const value: CsvColumn[] = payload.columns.map((c) => ({
    id: c.id,
    label: c.label,
    type: 'number' as const,
    ...(c.decimals === null ? {} : { decimals: c.decimals }),
  }));
  if (payload.variant === 'price') {
    return [...[head], ...value, { id: 'adjFactor', label: 'Adj factor', type: 'number' }];
  }
  return [
    ...[head],
    ...value,
    { id: 'status', label: 'Status', type: 'string' },
    { id: 'vintageAt', label: 'Vintage at', type: 'datetime' },
    { id: 'chgAbs', label: 'Change', type: 'number' },
    { id: 'chgPct', label: 'Change %', type: 'number' },
  ];
}

export function hpCsvRows(payload: HpPayload): (string | number | null)[][] {
  if (payload.variant === 'price') {
    return payload.rows.map((row) => [row.date, ...row.v, row.adjFactor]);
  }
  return payload.rows.map((row) => [
    row.date,
    ...row.v,
    row.status,
    row.vintageAt,
    row.chgAbs,
    row.chgPct,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keymap
//
// §HP's table lists `PageDown`/`PageUp`, `Enter`, `Shift+Enter` and `Ctrl+I` as **reserved** — the
// shell owns them (§2.6) and manifest invariant 3 forbids binding them here. They are documented
// in `help.keys` so HELP still shows the user what those keys do on this screen.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const KEYMAP: readonly KeyBinding[] = [
  { key: 'A', action: 'cycle-adjust', description: 'Next adjustment basis' },
  { key: 'P', action: 'cycle-periodicity', description: 'Next periodicity (D W M Q Y)' },
  { key: 'R', action: 'cycle-range', description: 'Next range' },
  { key: 'Shift+R', action: 'custom-range', description: 'Prompt for a custom start and end' },
  { key: 'F', action: 'pick-fields', description: 'Add a column (max 10)' },
  { key: 'Shift+F', action: 'remove-field', description: 'Remove the focused column (min 1)' },
  { key: 'C', action: 'set-currency', description: 'Convert to a currency' },
  { key: 'O', action: 'toggle-order', description: 'Newest first or oldest first' },
  { key: 'G', action: 'open-gp', description: 'Open GP over the same range' },
  { key: 'D', action: 'open-des', description: 'Open DES' },
];

const RESERVED_KEYS: readonly { key: string; action: string }[] = [
  { key: 'PageDown', action: 'Page forward (older rows when newest first)' },
  { key: 'PageUp', action: 'Page back (newer rows when newest first)' },
  { key: 'Enter', action: 'Open GP centred on the focused row’s date' },
  { key: 'Shift+Enter', action: 'The same, in the next panel' },
  { key: 'Ctrl+I', action: 'Provenance of the focused cell' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const HP = defineFunction<typeof HpParams, HpPayload>({
  code: 'HP',
  name: 'Historical Price Table',
  aliases: ['HIST'],
  tier: 1,
  category: 'pricing',
  assetClasses: ['equity', 'etf', 'index', 'fx', 'crypto', 'govt', 'rate', 'econ'],
  requiresSecurity: true,
  variants: {
    equity: 'price',
    etf: 'price',
    index: 'price',
    fx: 'price',
    crypto: 'price',
    govt: 'series',
    rate: 'series',
    econ: 'series',
  },
  params: HpParams,
  paramGrammar: {
    positional: [
      { name: 'range', type: 'range', optional: true },
      { name: 'start', type: 'date', optional: true },
      { name: 'end', type: 'date', optional: true },
      { name: 'periodicity', type: 'enum', values: Periodicity.options, optional: true },
    ],
    keyed: {
      ADJ: { name: 'adjust', type: 'enum', values: AdjustPolicy.options },
      CCY: { name: 'currency', type: 'currency' },
      FLDS: { name: 'fields', type: 'string' },
      ORDER: { name: 'order', type: 'enum', values: ['desc', 'asc'] },
      N: { name: 'pageSize', type: 'int' },
    },
  },
  fieldIds: fieldsFor,
  pageable: true,
  live: null,
  csv: {
    filename: (_params, ctx) => `HP_${slugOf(ctx.display)}_${asOfCompact(ctx.asOf)}.csv`,
    columns: (_params, payload) => hpCsvColumns(payload),
    rows: (payload) => hpCsvRows(payload),
  },
  help: {
    summary: 'Historical price table at any periodicity and adjustment basis, exportable',
    description:
      'HP lists closed sessions for the loaded security: daily, weekly, monthly, quarterly or ' +
      'yearly rows built from unadjusted daily bars with corporate actions applied on read (A ' +
      'cycles price, total return and unadjusted; the factors used are shown above the table and ' +
      'in the CSV header).\n\n' +
      'Columns are chosen with F from the price fields of the dictionary; currency conversion uses ' +
      'ECB reference rates at each date. The current session is never included — it appears ' +
      'after the close.\n\n' +
      'Treasuries show the on-the-run tenor’s curve history, rates show fixings with ' +
      'percentiles and volume, economic series show observations as known at the knownAt shown in ' +
      'the footer (revisions are separate vintages). PRINT exports the rows on screen with the ' +
      'same numbers.',
    params: [
      { name: 'range', text: '1M … MAX, or CUSTOM with two dates', example: '5Y' },
      { name: 'start', text: 'Custom window start', example: '2020-01-01' },
      { name: 'end', text: 'Custom window end', example: '2020-12-31' },
      { name: 'periodicity', text: 'D W M Q Y', example: 'W' },
      { name: 'adjust', text: 'price, total_return, unadjusted', example: 'ADJ=TR' },
      { name: 'currency', text: 'ISO 4217 code', example: 'CCY=EUR' },
      { name: 'fields', text: 'Comma-separated price field ids', example: 'FLDS=PX_LAST,PX_VOLUME' },
      { name: 'order', text: 'desc or asc', example: 'ORDER=ASC' },
      { name: 'pageSize', text: 'Rows per page, 20–500', example: 'N=100' },
    ],
    keys: [...KEYMAP.map((k) => ({ key: k.key, action: k.description })), ...RESERVED_KEYS],
    sources: [
      'yahoo.chart',
      'frankfurter',
      'treasury.yieldcurve',
      'treasury.bills',
      'nyfed.rates',
      'fred.csv',
      'bls.timeseries',
      'worldbank',
      'imf.datamapper',
      'internal.derived',
    ],
    related: ['GP', 'DES', 'CACS', 'GIP'],
  },
  keymap: KEYMAP,
  screenKind: 'declarative',
  payloadVersion: 1,
});
