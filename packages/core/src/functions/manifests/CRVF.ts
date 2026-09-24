// packages/core/src/functions/manifests/CRVF.ts
//
// `CRVF` — Curve Construction (FUNCTIONS_TIER3.md §CRVF L227-363, FUNCTIONS.md §6 L1106).
//
// The screen that shows how a curve is *made*: the published inputs of one curve date, the
// bootstrapped zero/discount/forward nodes those inputs imply, the build that produced them
// (`method`, `interpolation`, engine name@version, `inputsHash`, `buildId`) and up to three earlier
// dates overlaid with their basis-point changes. Every build is persisted as a `curve_builds` row
// and keyed by its inputs hash, so the same inputs are never bootstrapped twice and the same
// screen re-run a week later returns the same numbers (ANAL-02, ANAL-08).
//
// `ICVS` and `OIS` are aliases carrying `aliasParams { curveId: 'SOFR_OIS' }` — FUNCTIONS.md §6
// L1106 and `core/test/command/parser.test.ts` both pin that, and the parser applies `aliasParams`
// before the zod parse. FUNCTIONS_TIER3's separate `### ICVS` entry proposes promoting ICVS to a
// manifest of its own (curve-vs-curve comparison); that is a catalogue change with its own payload
// and is not made here. What is built is the catalogue as registered: one manifest, three aliases.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§CRVF "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The five stored curves (§CRVF's build table). */
export const CRVF_CURVE_IDS = ['UST_PAR', 'UST_BILL', 'UST_CMT', 'SOFR_FIX', 'SOFR_OIS'] as const;
export type CrvfCurveId = (typeof CRVF_CURVE_IDS)[number];

export const CRVF_OUTPUTS = ['input', 'par', 'zero', 'df', 'fwd3m', 'fwd1y'] as const;
export type CrvfOutput = (typeof CRVF_OUTPUTS)[number];

export const CrvfParams = z.object({
  curveId: z.enum(CRVF_CURVE_IDS).default('UST_PAR'),
  /** `null` = the latest stored `curve_date ≤ validAt`. */
  date: z.iso.date().nullable().default(null),
  /** Dashed comparison curves, earlier dates of the same curve. */
  compare: z.array(z.iso.date()).max(3).default([]),
  /** `null` = `curves.default_interpolation`. */
  interpolation: z
    .enum(['linear_zero', 'log_linear_df', 'monotone_convex'])
    .nullable()
    .default(null),
  outputs: z
    .array(z.enum(CRVF_OUTPUTS))
    .min(1)
    .default(['input', 'par', 'zero', 'df', 'fwd3m']),
  /** The node grid of the table: the input tenors, or a regular grid out to 30Y. */
  grid: z.enum(['inputs', 'monthly', 'quarterly']).default('inputs'),
  view: z.enum(['both', 'chart', 'table']).default('both'),
});
export type CrvfParams = z.infer<typeof CrvfParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§CRVF "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type CrvfCaveat =
  | 'PROXY_CURVE'
  | 'NO_OIS_SWAP_QUOTES_SOURCE'
  | 'FIXING_ONLY_NO_TERM_STRUCTURE'
  | 'SINGLE_DATE_ONLY'
  /**
   * **Addition to §CRVF's four caveats.** The published tenor set could not be bootstrapped, so
   * the screen shows the inputs and no nodes. It exists because WP-02's `curve.bootstrap` treats
   * every `par_yield` point as a par coupon bond and raises on a tenor shorter than one coupon
   * period — which is exactly what the Treasury publishes at 1M, 1.5M, 2M, 3M and 4M and what
   * `ingest/jobs/treasuryCurves.ts` stores. A screen that 500s on the real curve is worse than one
   * that shows what was published and names the reason.
   */
  | 'BOOTSTRAP_UNAVAILABLE';

export interface CrvfCurveBlock {
  id: string;
  name: string;
  currency: string;
  kind: string;
  dayCount: string;
  compounding: string;
  sourceId: string;
  provIdx: number;
  /** The date actually served. */
  date: string;
  /** What was asked for, when a date was typed. */
  requestedDate: string | null;
  /** Stored curve dates, descending, ≤ 400. */
  availableDates: string[];
}

export interface CrvfBuildBlock {
  /** `-1` when the curve has no term structure and nothing was bootstrapped. */
  buildId: number;
  method: 'bills+par_bootstrap' | 'ois_bootstrap' | 'none';
  interpolation: string;
  engine: { name: string; version: string; inputsHash: string } | null;
  caveats: CrvfCaveat[];
  /** True when the build came out of `curve_builds` rather than out of the bootstrap (ANAL-08). */
  cached: boolean;
}

export interface CrvfInputRow {
  tenor: string;
  tenorDays: number;
  quoteType: string;
  value: ValueCell;
  instrument: { instrumentId: number; key: string } | null;
  maturityDate: string | null;
  /** True when the point's own source is `internal.derived` — a SOFR_OIS proxy. */
  proxy: boolean;
  proxyOf: string | null;
  provIdx: number;
}

/** One row of the node table. Percent everywhere except `df`. */
export interface CrvfNode {
  tenor: string;
  /** Year fraction on the curve's own day count. */
  t: number;
  days: number;
  par: number | null;
  zero: number | null;
  df: number | null;
  fwd3m: number | null;
  fwd1y: number | null;
  isInput: boolean;
}

export interface CrvfCompareNode {
  tenor: string;
  t: number;
  par: number | null;
  zero: number | null;
  df: number | null;
}

export interface CrvfCompare {
  date: string;
  buildId: number | null;
  provIdx: number;
  nodes: CrvfCompareNode[];
}

export interface CrvfChange {
  tenor: string;
  vsCompare: { date: string; parBp: number | null; zeroBp: number | null }[];
}

export interface CrvfPayload {
  variant: 'default';
  curve: CrvfCurveBlock;
  build: CrvfBuildBlock;
  inputs: CrvfInputRow[];
  nodes: CrvfNode[];
  compare: CrvfCompare[];
  changes: CrvfChange[];
  /** `ctx.asOf.validAt`, so the CSV and the footer quote the same instant. */
  asOf: string;
}

/** The persistent amber badge SOFR_OIS carries everywhere (BRIEF §2). */
export const CRVF_PROXY_DETAIL =
  'SOFR OIS term points are proxied (SOFRAI averages, bills, UST par); no OIS swap or futures ' +
  'source (BRIEF §2)';

/** The detail behind `BOOTSTRAP_UNAVAILABLE`, prefixed to the engine's own message. */
export const CRVF_BOOTSTRAP_DETAIL =
  'the published tenors of this curve could not be bootstrapped, so only the inputs are shown';

/** `SOFR_FIX` is one overnight fixing: there is no term structure to bootstrap. */
export const CRVF_FIXING_DETAIL =
  'SOFR_FIX stores the overnight fixing only; par, zero and discount factors beyond ON would be ' +
  'invented, so they are left blank';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§CRVF "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CRVF_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'CRV_1M',
  'CRV_2M',
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
  'CURVE_ZERO',
  'CURVE_DF',
  'CURVE_FWD_3M',
  'RATE',
  'RATE_AVG_30D',
  'RATE_AVG_90D',
  'RATE_AVG_180D',
] as const);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§CRVF "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CRVF_CSV_COLUMNS: CsvColumn[] = [
  { id: 'date', label: 'Date', type: 'date' },
  { id: 'tenor', label: 'Tenor', type: 'string' },
  { id: 'days', label: 'Days', type: 'number' },
  { id: 't', label: 'T', type: 'number', decimals: 6 },
  { id: 'quoteType', label: 'Quote type', type: 'string' },
  { id: 'input', label: 'Input', type: 'number', decimals: 4 },
  { id: 'par', label: 'Par', type: 'number', decimals: 4 },
  { id: 'zero', label: 'Zero', type: 'number', decimals: 4 },
  { id: 'df', label: 'DF', type: 'number', decimals: 8 },
  { id: 'fwd3m', label: 'Fwd 3M', type: 'number', decimals: 4 },
  { id: 'fwd1y', label: 'Fwd 1Y', type: 'number', decimals: 4 },
  { id: 'proxy', label: 'Proxy', type: 'boolean' },
  { id: 'source', label: 'Source', type: 'string' },
];

type CsvRow = (string | number | boolean | null)[];

function crvfCsvRows(payload: CrvfPayload): CsvRow[] {
  const inputs = new Map(payload.inputs.map((row) => [row.tenor, row]));
  const rows: CsvRow[] = payload.nodes.map((node) => {
    const input = node.isInput ? inputs.get(node.tenor) : undefined;
    return [
      payload.curve.date,
      node.tenor,
      node.days,
      node.t,
      input?.quoteType ?? '',
      input === undefined ? null : (input.value.v),
      node.par,
      node.zero,
      node.df,
      node.fwd3m,
      node.fwd1y,
      input?.proxy ?? false,
      input === undefined ? '' : payload.curve.sourceId,
    ];
  });
  for (const compare of payload.compare) {
    for (const node of compare.nodes) {
      rows.push([
        compare.date,
        node.tenor,
        null,
        node.t,
        '',
        null,
        node.par,
        node.zero,
        node.df,
        null,
        null,
        false,
        payload.curve.sourceId,
      ]);
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CRVF = defineFunction<typeof CrvfParams, CrvfPayload>({
  code: 'CRVF',
  name: 'Curve Construction',
  aliases: ['ICVS', 'CURVE', 'OIS'],
  aliasParams: {
    ICVS: { curveId: 'SOFR_OIS' },
    OIS: { curveId: 'SOFR_OIS' },
  },
  tier: 3,
  category: 'rates',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: CrvfParams,
  paramGrammar: {
    positional: [
      { name: 'curveId', type: 'curve', optional: true },
      { name: 'date', type: 'date', optional: true },
    ],
    keyed: {
      CMP: { name: 'compare', type: 'date' },
      INTERP: {
        name: 'interpolation',
        type: 'enum',
        values: ['linear_zero', 'log_linear_df', 'monotone_convex'],
      },
      GRID: { name: 'grid', type: 'enum', values: ['inputs', 'monthly', 'quarterly'] },
    },
  },
  fieldIds: (): FieldId[] => [...CRVF_FIELD_IDS],
  pageable: false,
  live: (params): LiveSpec => ({
    subjects: [`c:${params.curveId}`],
    fields: '*',
    conflationMs: 1000,
  }),
  csv: {
    filename: (params, ctx): string =>
      `CRVF_${params.curveId}_${(params.date ?? ctx.asOf.slice(0, 10)).replace(/-/g, '')}.csv`,
    columns: CRVF_CSV_COLUMNS,
    rows: (payload): CsvRow[] => crvfCsvRows(payload),
  },
  help: {
    summary: 'Treasury par/bill/CMT and SOFR OIS curves: inputs, bootstrap, zero/df/forwards',
    description:
      'CRVF shows a stored curve for a date with its published inputs and the bootstrapped zero, ' +
      'discount-factor and forward nodes, and overlays up to three earlier dates with ' +
      'basis-point changes. ICVS opens the SOFR OIS curve, which in this build is constructed ' +
      'from proxies (SOFR fixing, realised SOFR averages, bills and Treasury par yields) because ' +
      'no OIS swap quotes are available; the PROXY_CURVE badge stays on every screen that uses ' +
      'it. Interpolation, the node grid and the output set are parameters; every build is cached ' +
      'by its inputs hash and reproducible.',
    params: [
      { name: 'curveId', text: 'UST_PAR, UST_BILL, UST_CMT, SOFR_FIX, SOFR_OIS', example: 'SOFR_OIS' },
      { name: 'date', text: 'curve date; default latest', example: '2026-09-08' },
      { name: 'compare', text: 'up to three dates to overlay', example: 'CMP=2026-09-01' },
      { name: 'interpolation', text: 'linear_zero, log_linear_df, monotone_convex' },
      { name: 'outputs', text: 'columns and series to show' },
      { name: 'grid', text: 'inputs, monthly or quarterly nodes' },
      { name: 'view', text: 'both, chart or table' },
    ],
    keys: [
      { key: 'D', action: 'prompt for a curve date' },
      { key: 'C', action: 'add a comparison date' },
      { key: 'K', action: 'cycle the curve' },
      { key: 'I', action: 'cycle the interpolation' },
      { key: 'R', action: 'cycle the node grid' },
    ],
    sources: [
      'treasury.yieldcurve',
      'treasury.bills',
      'fed.h15',
      'nyfed.rates',
      'internal.derived',
    ],
    related: ['GC', 'YAS', 'SWPM', 'WIRP', 'BTMM'],
  },
  keymap: [
    { key: 'D', action: 'date-prompt', description: 'Prompt for a curve date' },
    {
      key: 'ArrowLeft',
      action: 'prev-date',
      when: 'chart',
      description: 'Previous stored curve date',
    },
    {
      key: 'ArrowRight',
      action: 'next-date',
      when: 'chart',
      description: 'Next stored curve date',
    },
    { key: 'C', action: 'add-compare', description: 'Add a comparison date (max 3)' },
    { key: 'X', action: 'clear-compare', description: 'Clear the comparison dates' },
    { key: 'I', action: 'cycle-interp', description: 'Cycle the interpolation' },
    { key: 'O', action: 'cycle-outputs', description: 'Toggle the focused output column' },
    { key: 'R', action: 'cycle-grid', description: 'Cycle inputs / monthly / quarterly' },
    { key: 'V', action: 'cycle-view', description: 'Cycle both / chart / table' },
    { key: 'K', action: 'cycle-curve', description: 'Cycle the five stored curves' },
    {
      key: 'Enter',
      action: 'row-provenance',
      when: 'grid',
      description: 'Provenance of the focused input row',
    },
    {
      key: 'Shift+Enter',
      action: 'open-yas-next',
      when: 'grid',
      description: 'Price the row instrument in the next panel',
    },
    { key: 'G', action: 'open-gc', description: 'Benchmark curve chart' },
    { key: 'W', action: 'open-wirp', description: 'Implied policy path' },
  ],
  screenKind: 'custom',
  payloadVersion: 1,
});

export default CRVF;
