// packages/core/src/functions/manifests/FXC.ts
//
// `FXC` — FX Cross Matrix (FUNCTIONS_TIER2.md §FXC L2080-2225, FUNCTIONS.md §6 `none → default`).
//
// Nine pairs are real instruments quoted against the dollar and update live from the plant. Every
// other cell in the matrix is derived, and the payload says exactly how: `kind` is one of
// `unity | direct | inverse | cross`, `derivation` is the arithmetic in the trader's own notation
// (`'EURUSD × USDJPY'`, `'1 / USDJPY'`) and `via` names the vehicle currency. A cross whose legs
// disagree about freshness takes the worse of the two states, and a cross with one null leg is
// `na` — never the surviving leg on its own.
//
// Two deviations from the tier document, both forced by the runner's payload-honesty rules
// (`functions/runner.ts#assertPayloadMeta`, DATA-10) and recorded here:
//
//  1. **The unity cell carries no number.** §FXC writes `rate = { v: 1, st:'closed', provIdx: -1 }`.
//     The runner rejects a finite number in a `ValueCell` with a negative `provIdx`: `-1` is
//     reserved for the pending cell, whose `v` is null. There is also nothing to cite — no source
//     publishes USD/USD — so the diagonal is `{ v: null, st: 'na', provIdx: -1 }`, which is what
//     the §FXC screen sketch already renders (`USD  —`). {@link FXC_UNITY_RATE} is that constant
//     for a consumer that wants the number.
//  2. **`csv.columns` is a function of `(params, payload)` rather than a static array.** The
//     honesty walk treats a static column id as a cell name anywhere in the payload, and three of
//     §FXC's column ids (`decimals`, `via`, `derivation`) are cell *metadata*: `decimals` is a
//     rendering hint that cites nothing, `via` and `derivation` are null on a direct cell. Declared
//     statically they would make a correct payload look like uncited numbers and unexplained gaps.
//     The function returns the same fixed list §FXC specifies, in the same order.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { defineFunction, type CsvColumn, type CsvDocument, type LiveSpec } from '../manifest.js';
import type { MonitorColumn, MonitorRow } from '../shared/monitor.js';
import { monitorPrecheckFields } from './QM.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§FXC "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The G10 axis order the screen opens on. */
export const FXC_G10: readonly string[] = Object.freeze([
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'NZD',
  'SEK',
  'NOK',
]);

export const FxcParams = z.object({
  ccys: z
    .array(z.string().regex(/^[A-Z]{3}$/))
    .min(2)
    .max(10)
    .default([...FXC_G10]),
  /** `live` = the plant's `yahoo.chart` lines; `ecb` = the `frankfurter` fixings in `fx_rates`. */
  quote: z.enum(['live', 'ecb']).default('live'),
  /** ecb mode: `fx_rates.rate_date`; undefined = the latest ≤ `ctx.asOf.validAt`. */
  date: z.iso.date().optional(),
  /** `auto` = from `fx_terms.pip_size`. */
  decimals: z.enum(['auto', '2', '4', '5']).default('auto'),
  /** Swap the base (rows) and quote (columns) axes. */
  transpose: z.boolean().default(false),
});
export type FxcParams = z.infer<typeof FxcParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§FXC "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type FxcCellKind = 'unity' | 'direct' | 'inverse' | 'cross';

/** The rate of a currency against itself. See deviation 1: the payload cell carries `null`. */
export const FXC_UNITY_RATE = 1;

export interface FxcCell {
  base: string;
  quote: string;
  kind: FxcCellKind;
  /** Units of `quote` per 1 `base`. */
  rate: ValueCell;
  /** live mode only; ecb mode is `{ v: null, st: 'na' }`. */
  chgPct1d: ValueCell;
  decimals: number;
  instrumentId: number | null;
  /** `'EURUSD Curncy'` for direct/inverse; `null` for cross and unity. */
  key: string | null;
  subject: string | null;
  /** `'USD'` on a cross cell; `null` otherwise. */
  via: string | null;
  /** `'EURUSD × USDJPY'` | `'1 / USDJPY'`. */
  derivation: string | null;
  /**
   * The provenance of the cell's **primary** leg. A cross also carries {@link legProvIdx}, because
   * §FXC's acceptance row is that a derived cross cites the provenance of BOTH legs, not one, and
   * a single index cannot say where the second number came from.
   */
  provIdx: number;
  /** Every provenance index this cell's value depends on, in leg order. */
  legProvIdx: number[];
  /** The source ids behind `legProvIdx`, in the same order — what the CSV's `sourceId` joins. */
  legSourceIds: string[];
}

export interface FxcEcbCompare {
  base: string;
  quote: string;
  live: number | null;
  ecb: number | null;
  diffPct: number | null;
}

export const INDICATIVE_MID_ONLY = 'INDICATIVE_MID_ONLY';
export const NO_FX_DEPTH_SOURCE = 'NO_FX_DEPTH_SOURCE';
export const CROSSES_DERIVED_VIA_USD = 'CROSSES_DERIVED_VIA_USD';
export const ECB_FIXING_STALE = 'ECB_FIXING_STALE';

export const FXC_DEPTH_DETAIL =
  'NO_FX_DEPTH_SOURCE: no reachable source publishes an FX bid/ask; PX_BID and PX_ASK are absent ' +
  'for fx instruments';
export const FXC_FORWARD_DETAIL =
  'NO_FORWARD_POINTS_SOURCE: FX forwards and the swap curve are out of scope (DATA-05, BRIEF §1)';
export const FXC_ECB_CHG_DETAIL =
  'the ECB publishes one daily fixing; there is no intraday change';

export interface FxcPayload {
  variant: 'default';
  quote: 'live' | 'ecb';
  /** ecb mode: the `fx_rates.rate_date` used; `null` in live mode. */
  rateDate: string | null;
  /** Axis order after `params.transpose`. */
  ccys: string[];
  matrix: FxcCell[][];
  /** The seeded direct pairs, as a monitor grid. */
  pairs: MonitorRow[];
  pairColumns: MonitorColumn[];
  ecbCompare: FxcEcbCompare[] | null;
  /** Requested currencies with no seeded USD pair. */
  missing: string[];
  notes: string[];
  /**
   * `ctx.asOf.validAt` as ISO-8601. Addition to §FXC's payload: `CsvSpec.rows(payload, params)` is
   * not handed the as-of, and §FXC's own CSV example carries it in every row, so the instant the
   * matrix reproduces at has to be in the payload to reach the export. WEI carries the same key
   * for the same reason.
   */
  asOf: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Decimals (§FXC resolver step 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `fx_terms.pip_size` → display decimals: `0.01` → 2 (the yen pairs), `0.0001` → 4, and in general
 * the number of decimal places the pip itself has. A pip size that is not a negative power of ten
 * falls back to 4 rather than producing a fractional count.
 */
export function decimalsOfPip(pipSize: number | null): number {
  if (pipSize === null || !Number.isFinite(pipSize) || pipSize <= 0) return 4;
  const places = Math.round(-Math.log10(pipSize));
  return places >= 0 && places <= 8 ? places : 4;
}

/** `params.decimals` applied over the pip-derived default. */
export function fxcDecimals(param: FxcParams['decimals'], pipSize: number | null): number {
  return param === 'auto' ? decimalsOfPip(pipSize) : Number(param);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§FXC "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FXC_PAIR_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'LAST_TRADE_TIME',
]);

export const FXC_PRECHECK_SUPERSET: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'PX_OFFICIAL_CLOSE',
  'LAST_TRADE_TIME',
  'SESSION_STATE',
]);

export const FXC_LIVE_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'LAST_TRADE_TIME',
  'SESSION_STATE',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§FXC "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const FXC_COLUMNS: CsvColumn[] = [
  { id: 'base', label: 'Base', type: 'string' },
  { id: 'quote', label: 'Quote', type: 'string' },
  { id: 'rate', label: 'Rate', type: 'number' },
  { id: 'kind', label: 'Kind', type: 'string' },
  { id: 'via', label: 'Via', type: 'string' },
  { id: 'derivation', label: 'Derivation', type: 'string' },
  { id: 'chgPct1d', label: 'Change %', type: 'number' },
  { id: 'decimals', label: 'Decimals', type: 'number' },
  { id: 'asOf', label: 'As of', type: 'datetime' },
  { id: 'sourceId', label: 'Source', type: 'string' },
];

function fxcCsvColumns(_params: FxcParams, _payload: FxcPayload): CsvColumn[] {
  return [...FXC_COLUMNS];
}

function fxcCsvRows(payload: FxcPayload, asOf: string): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  for (const row of payload.matrix) {
    for (const cell of row) {
      if (cell.kind === 'unity') continue;
      rows.push([
        cell.base,
        cell.quote,
        typeof cell.rate.v === 'number' ? cell.rate.v : null,
        cell.kind,
        cell.via,
        cell.derivation,
        typeof cell.chgPct1d.v === 'number' ? cell.chgPct1d.v : null,
        cell.decimals,
        asOf,
        cell.legSourceIds.join(','),
      ]);
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FXC = defineFunction<typeof FxcParams, FxcPayload>({
  code: 'FXC',
  name: 'FX Cross Matrix',
  aliases: ['FX', 'CROSS'],
  tier: 2,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: FxcParams,
  paramGrammar: {
    positional: [{ name: 'ccys', type: 'string', optional: true }],
    keyed: {
      SRC: { name: 'quote', type: 'enum', values: ['live', 'ecb'] },
      DT: { name: 'date', type: 'date' },
      DEC: { name: 'decimals', type: 'enum', values: ['auto', '2', '4', '5'] },
      T: { name: 'transpose', type: 'boolean' },
    },
  },
  fieldIds: (): FieldId[] => monitorPrecheckFields(FXC_PRECHECK_SUPERSET),
  pageable: false,
  live: (_params, payload): LiveSpec | null =>
    payload.quote === 'ecb' || payload.pairs.length === 0
      ? null
      : {
          subjects: payload.pairs.map((r) => r.subject),
          fields: [...FXC_LIVE_FIELDS],
          conflationMs: 500,
        },
  csv: {
    filename: (params, ctx): string =>
      `FXC_${params.quote.toUpperCase()}_${ctx.asOf.replace(/[-:]/g, '')}.csv`,
    columns: fxcCsvColumns,
    rows: (payload, _params): CsvDocument['rows'] => fxcCsvRows(payload, payload.asOf),
  },
  help: {
    summary: 'G10 cross-rate matrix: direct pairs live, crosses derived via USD, ECB reference toggle',
    description:
      'FXC shows every cross between the selected currencies in one matrix. Nine pairs are real ' +
      'instruments quoted against the US dollar and update live from the ticker plant; every other ' +
      'cell is derived — an inverse of a quoted pair, or a cross computed through the dollar — and ' +
      'says so, with the exact derivation available on Enter. Press 2 for the ECB reference fixing ' +
      'instead of the live mid, and D to pick a fixing date. The comparison table shows how far ' +
      'the delayed indicative mid sits from the ECB fixing for the same day. There are no bid/ask ' +
      'spreads and no forward points: the reachable sources publish an indicative mid only, and ' +
      'interbank FX is out of scope for this build.',
    params: [
      { name: 'ccys', text: 'ISO currency codes, comma-separated', example: 'FXC EUR,USD,JPY' },
      { name: 'quote', text: 'live or ecb', example: 'SRC=ECB' },
      { name: 'date', text: 'ECB fixing date', example: 'DT=2026-09-15' },
      { name: 'decimals', text: 'auto, 2, 4 or 5', example: 'DEC=5' },
      { name: 'transpose', text: 'swap the axes', example: 'T=1' },
    ],
    keys: [
      { key: '1 / 2', action: 'live or ECB reference' },
      { key: 'T', action: 'transpose the axes' },
      { key: '+ / -', action: 'more / fewer decimals' },
      { key: 'Enter', action: 'DES, or the derivation of a cross' },
      { key: 'B', action: 'BTMM' },
    ],
    sources: ['yahoo.chart', 'frankfurter'],
    related: ['BTMM', 'WB', 'GP', 'HP', 'DES', 'PORT'],
  },
  keymap: [
    { key: '1', action: 'tab-quote', description: 'Live indicative mid' },
    { key: '2', action: 'tab-quote', description: 'ECB reference fixing' },
    { key: 'T', action: 'toggle-transpose', description: 'Swap the axes' },
    { key: '+', action: 'more-decimals', description: 'More decimals' },
    { key: '-', action: 'fewer-decimals', description: 'Fewer decimals' },
    { key: 'D', action: 'set-date', description: 'Pick the ECB fixing date' },
    { key: 'Enter', action: 'open-des', when: 'grid', description: 'DES, or the derivation' },
    {
      key: 'Shift+Enter',
      action: 'open-des-next',
      when: 'grid',
      description: 'DES in the next panel',
    },
    { key: 'G', action: 'open-gp', when: 'grid', description: 'Chart the focused pair' },
    { key: 'H', action: 'open-hp', when: 'grid', description: 'History of the focused pair' },
    {
      key: 'Ctrl+W',
      action: 'add-watchlist',
      when: 'grid',
      description: 'Save the nine pairs as a watchlist',
    },
    { key: 'B', action: 'open-btmm', description: 'Treasury and money markets' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default FXC;
