// packages/core/src/functions/manifests/BTMM.ts
//
// `BTMM` — Treasury & Money Markets (FUNCTIONS_TIER2.md §BTMM L1898-2079, FUNCTIONS.md §6).
//
// The rates desk's morning page: the policy range as the New York Fed publishes it beside the EFFR
// fixing, the six overnight reference rates with their percentiles, the bill curve with its
// on-the-run CUSIPs, the Treasury par (or H.15 constant-maturity) curve with a basis-point change
// column, and the spreads computed from exactly those published numbers. The §6 binding row is
// `none → default`.
//
// Three things this page will not do:
//
//  * **It will not compute a spread from a partial pair.** A missing leg yields `st:'na'` and a
//    `NO_SOURCE` note, never a number that silently drops one side.
//  * **It will not invent the three cells the reachable sources do not publish.** IORB, the
//    discount window and the implied policy path are structurally null with their own reason
//    codes; the path lives in WIRP, derived from the money-market curve, and the footer says so.
//  * **It will not present SOFRAI as a rate.** The SOFR averages index has no daily rate and no
//    percentiles (PROVIDERS §10.4); its rate cells are `na`, never a zero.
//
// `RateFixingRow`, `CurvePointRow` and `SpreadRow` are declared here rather than in the
// `core/functions/shared/rates.ts` the tier document names: that file is not part of this task's
// file list and nothing outside BTMM and WB needs the shapes yet. All three are exported, so
// moving them later is a re-export rather than a rewrite. `WB.ts` imports `CurvePointRow` from
// here, exactly as §WB says ("shared CurvePointRow, BTMM entry").
//
// One deviation from the tier document, recorded here and in the report:
//
//  * **`fieldIds()` is the plant-read subset, not the whole list.** §BTMM names the curve and bill
//    ids (`CRV_*`, `DISC_RATE`, `BEY`) in the pre-check set. Those fields are licensed from
//    `treasury.yieldcurve` / `treasury.bills`, whose `licence_registry.max_tier` is `eod`, and
//    `EntitlementDecision.effectiveTier` is the MINIMUM over the fields asked about — which then
//    seeds the plant gate for the whole run (`functions/context.ts#buildContext`). Pre-checking a
//    published curve would therefore freeze the `context` FX and index quotes at the official close
//    with `TIER_EOD`, for no reason anyone could act on: the curve blocks are stored-value cells
//    that the plant gate never touches. QM.ts records the same rule ("a monitor pre-checks the
//    fields it actually reads FROM THE PLANT") and the same cost. The full §BTMM list is kept as
//    {@link BTMM_FIELD_IDS} and is what the screen subscribes to.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { defineFunction, type CsvColumn, type CsvDocument, type LiveSpec } from '../manifest.js';
import type { MonitorRow } from '../shared/monitor.js';
import { monitorPrecheckFields } from './QM.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§BTMM "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const BtmmSections = [
  'ALL',
  'POLICY',
  'OVERNIGHT',
  'BILLS',
  'CURVE',
  'SPREADS',
  'CONTEXT',
] as const;
export type BtmmSection = (typeof BtmmSections)[number];

export const BtmmCurveIds = ['UST_PAR', 'UST_CMT'] as const;
export type BtmmCurveId = (typeof BtmmCurveIds)[number];

export const BtmmParams = z.object({
  section: z.enum(BtmmSections).default('ALL'),
  /** `curve_points.curve_date` for the bp-change column; undefined = the previous stored date. */
  compareDate: z.iso.date().optional(),
  spreadUnits: z.enum(['bp', 'pct']).default('bp'),
  /** Show the `RATE_P1/P25/P75/P99` columns on the overnight block. */
  percentiles: z.boolean().default(true),
  curveId: z.enum(BtmmCurveIds).default('UST_PAR'),
});
export type BtmmParams = z.infer<typeof BtmmParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared rate shapes (§BTMM "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const BTMM_RATE_CODES = ['SOFR', 'EFFR', 'OBFR', 'TGCR', 'BGCR', 'SOFRAI'] as const;
export type BtmmRateCode = (typeof BTMM_RATE_CODES)[number];

export const BTMM_RATE_LABELS: Readonly<Record<BtmmRateCode, string>> = Object.freeze({
  SOFR: 'Secured Overnight Financing Rate',
  EFFR: 'Effective Federal Funds Rate',
  OBFR: 'Overnight Bank Funding Rate',
  TGCR: 'Tri-Party General Collateral Rate',
  BGCR: 'Broad General Collateral Rate',
  SOFRAI: 'SOFR Averages and Index',
});

/** One NY Fed reference-rate fixing as BTMM, FED and WIRP render it. `subject` is `'r:<rateCode>'`. */
export interface RateFixingRow {
  rateCode: BtmmRateCode;
  label: string;
  publisher: 'NY Fed';
  effectiveDate: string;
  vintageAt: string;
  isLatest: boolean;
  subject: string;
  rate: ValueCell;
  p1: ValueCell;
  p25: ValueCell;
  p75: ValueCell;
  p99: ValueCell;
  volumeBn: ValueCell;
  /** `SOFRAI` only; a blank `na` cell on every other code. */
  avg30d: ValueCell;
  avg90d: ValueCell;
  avg180d: ValueCell;
  indexValue: ValueCell;
  /** `rate(t) − rate(t₋1)`, ×100 — resolver arithmetic on the fixing's own provenance. */
  chg1dBp: ValueCell;
  revisionIndicator: string;
  provIdx: number;
}

export type CurveQuoteType =
  | 'par_yield'
  | 'discount_rate'
  | 'investment_yield'
  | 'cmt_yield'
  | 'fixing';

/** One point of a stored curve (`UST_PAR`, `UST_CMT`, `UST_BILL`, `SOFR_FIX`). */
export interface CurvePointRow {
  curveId: string;
  /** `'1M'`, `'10Y'` | `'4WK'`, `'13WK'` | `'ON'`. */
  tenor: string;
  tenorDays: number;
  quoteType: CurveQuoteType;
  value: ValueCell;
  compareValue: ValueCell;
  chgBp: ValueCell;
  /** Bills only — `treasury.bills` mints these. */
  instrumentId: number | null;
  cusip: string | null;
  maturityDate: string | null;
  onTheRun: boolean;
  /** `'CRV_10Y'` …; `null` for a tenor with no dictionary id (`1.5M`, `2M`, `4M`, the bills). */
  fieldId: FieldId | null;
  provIdx: number;
}

/** One derived spread. Derived cells cite the `provIdx` of their primary input (§0.4 rule 4). */
export interface SpreadRow {
  id: string;
  label: string;
  /** `'10Y par yield − 2Y par yield'`. */
  definition: string;
  value: ValueCell;
  compareValue: ValueCell;
  chgBp: ValueCell;
  unit: 'bp' | 'pct';
  fieldId: null;
  provIdx: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Structurally-null policy cells
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Like ECO's consensus these are not `ValueCell`s: `ValueCell.r` is the closed `ReasonCode` union
// and none of these codes is a member of it. Typing `v: null` means a resolver cannot put a number
// in the slot even by accident.

export interface BtmmMissing<R extends string> {
  v: null;
  r: R;
}

export const NO_IORB_SOURCE = 'NO_IORB_SOURCE';
export const NO_DISCOUNT_WINDOW_SOURCE = 'NO_DISCOUNT_WINDOW_SOURCE';
export const NO_FED_FUNDS_FUTURES = 'NO_FED_FUNDS_FUTURES';
export const CURVE_STALE = 'CURVE_STALE';
export const RATE_REVISED = 'RATE_REVISED';

export const BTMM_IORB_DETAIL =
  'NO_IORB_SOURCE: interest on reserve balances is not published by any keyless source in the ' +
  'reachable set (BRIEF §2); the target range and EFFR are shown instead';
export const BTMM_DISCOUNT_WINDOW_DETAIL =
  'NO_DISCOUNT_WINDOW_SOURCE: the primary-credit rate has no machine-readable keyless feed';
export const BTMM_IMPLIED_PATH_DETAIL =
  'NO_FED_FUNDS_FUTURES: CME FedWatch and fed funds futures are not reachable; WIRP derives the ' +
  'implied path from the SOFR fixing and the bill curve';
export const BTMM_SOFRAI_DETAIL =
  'SOFRAI publishes averages and an index level, not a daily rate (PROVIDERS §10.4)';

export interface BtmmMeeting {
  meetingDate: string;
  statementAt: string | null;
  hasSep: boolean;
  decisionBp: number | null;
  provIdx: number;
}

export interface BtmmNextMeeting extends BtmmMeeting {
  daysAway: number;
}

export interface BtmmPolicy {
  targetFrom: ValueCell;
  targetTo: ValueCell;
  /** Derived `(from + to) / 2`, citing the EFFR fixing. */
  targetMid: ValueCell;
  effectiveDate: string | null;
  lastMeeting: BtmmMeeting | null;
  nextMeeting: BtmmNextMeeting | null;
  iorb: BtmmMissing<typeof NO_IORB_SOURCE>;
  discountWindow: BtmmMissing<typeof NO_DISCOUNT_WINDOW_SOURCE>;
}

export interface BtmmCurveBlock {
  curveId: BtmmCurveId;
  /**
   * Widening of §BTMM, which types this `string`: `data.curves.points` throws `no_points` when a
   * curve has nothing stored on or before the as-of date, and a morning page that 500s because
   * last night's ingest has not run is worse than one that says the curve is missing. `null` is
   * that statement, and it travels with a `NO_SOURCE` entry.
   */
  curveDate: string | null;
  compareDate: string | null;
  points: CurvePointRow[];
  /** `curveDate` more than three `USGOVT` business days behind `ctx.asOf.validAt`. */
  stale: boolean;
}

export interface BtmmBillsBlock {
  curveDate: string | null;
  compareDate: string | null;
  points: CurvePointRow[];
}

export interface BtmmPayload {
  variant: 'default';
  section: BtmmSection;
  policy: BtmmPolicy;
  /** SOFR, EFFR, OBFR, TGCR, BGCR, SOFRAI in that order. */
  overnight: RateFixingRow[];
  bills: BtmmBillsBlock;
  curve: BtmmCurveBlock;
  spreads: SpreadRow[];
  context: { fx: MonitorRow[]; indices: MonitorRow[] };
  /** `'CURVE_STALE'`, `'NO_IORB_SOURCE'`, `'NO_FED_FUNDS_FUTURES'`, `'RATE_REVISED'`. */
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Spread definitions (§BTMM resolver step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How each spread is built, as data, so the resolver, the CSV and the screen agree on the label
 * and the definition string and nobody re-types `'10Y par yield − 2Y par yield'`.
 *
 * `curve` legs name a tenor of `params.curveId`; `rate` legs name a NY Fed code; `bill` names a
 * `UST_BILL` tenor with its quote type; `targetMid` is the policy midpoint; `cmt` names a tenor of
 * `UST_CMT` regardless of `params.curveId`, because `10Y par − 10Y CMT` is the cross-source check
 * of PROVIDERS §10.3 and both sides are fixed by definition.
 */
export type SpreadLeg =
  | { kind: 'curve'; tenor: string }
  | { kind: 'cmt'; tenor: string }
  | { kind: 'rate'; code: BtmmRateCode }
  | { kind: 'bill'; tenor: string; quoteType: CurveQuoteType }
  | { kind: 'targetMid' };

export interface SpreadDef {
  id: string;
  label: string;
  definition: string;
  minus: SpreadLeg;
  from: SpreadLeg;
}

export const BTMM_SPREADS: readonly SpreadDef[] = Object.freeze([
  {
    id: '2s10s',
    label: '2s10s',
    definition: '10Y par yield − 2Y par yield',
    from: { kind: 'curve', tenor: '10Y' },
    minus: { kind: 'curve', tenor: '2Y' },
  },
  {
    id: '3m10y',
    label: '3m10y',
    definition: '10Y par yield − 3M par yield',
    from: { kind: 'curve', tenor: '10Y' },
    minus: { kind: 'curve', tenor: '3M' },
  },
  {
    id: '5s30s',
    label: '5s30s',
    definition: '30Y par yield − 5Y par yield',
    from: { kind: 'curve', tenor: '30Y' },
    minus: { kind: 'curve', tenor: '5Y' },
  },
  {
    id: 'sofr_effr',
    label: 'SOFR − EFFR',
    definition: 'SOFR fixing − EFFR fixing',
    from: { kind: 'rate', code: 'SOFR' },
    minus: { kind: 'rate', code: 'EFFR' },
  },
  {
    id: 'bgcr_sofr',
    label: 'BGCR − SOFR',
    definition: 'BGCR fixing − SOFR fixing',
    from: { kind: 'rate', code: 'BGCR' },
    minus: { kind: 'rate', code: 'SOFR' },
  },
  {
    id: 'tgcr_bgcr',
    label: 'TGCR − BGCR',
    definition: 'TGCR fixing − BGCR fixing',
    from: { kind: 'rate', code: 'TGCR' },
    minus: { kind: 'rate', code: 'BGCR' },
  },
  {
    id: 'effr_target_mid',
    label: 'EFFR − target mid',
    definition: 'EFFR fixing − FOMC target range midpoint',
    from: { kind: 'rate', code: 'EFFR' },
    minus: { kind: 'targetMid' },
  },
  {
    id: 'bill13wk_sofr',
    label: '13WK bill − SOFR',
    definition: '13WK bill investment yield − SOFR fixing',
    from: { kind: 'bill', tenor: '13WK', quoteType: 'investment_yield' },
    minus: { kind: 'rate', code: 'SOFR' },
  },
  {
    id: 'par10y_cmt10y',
    label: '10Y par − 10Y CMT',
    definition: '10Y Treasury par yield − 10Y H.15 constant-maturity yield',
    from: { kind: 'curve', tenor: '10Y' },
    minus: { kind: 'cmt', tenor: '10Y' },
  },
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§BTMM "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The whole §BTMM list — what the screen subscribes to. See the file header for why `fieldIds()` is smaller. */
export const BTMM_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'RATE',
  'RATE_P1',
  'RATE_P25',
  'RATE_P75',
  'RATE_P99',
  'RATE_VOLUME_BN',
  'TARGET_FROM',
  'TARGET_TO',
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
  'DISC_RATE',
  'BEY',
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
]);

/**
 * The entitlement pre-check set: the NY Fed fixing fields, which are the only ones this screen
 * reads through the plant gate (`r:` subjects, and the `rate` cell's `live` binding).
 *
 * `RATE_AVG_30D`, `RATE_AVG_90D`, `RATE_AVG_180D` and `RATE_INDEX` are named by §BTMM but have no
 * `core/fields/dictionary.ts` entry in this build; `packages/core/src/fields/defs/econ.ts` belongs
 * to WP-11, so they are not added here and {@link monitorPrecheckFields} drops them. The SOFR
 * averages still render — they come out of `rate_fixings` as stored-value cells, which no field
 * licence gates.
 */
export const BTMM_PRECHECK_SUPERSET: readonly FieldId[] = Object.freeze([
  'RATE',
  'RATE_P1',
  'RATE_P25',
  'RATE_P75',
  'RATE_P99',
  'RATE_VOLUME_BN',
  'TARGET_FROM',
  'TARGET_TO',
  'RATE_AVG_30D',
  'RATE_AVG_90D',
  'RATE_AVG_180D',
  'RATE_INDEX',
]);

/** Field ids the live spec asks for; see §BTMM "Live". */
export const BTMM_LIVE_FIELDS: readonly FieldId[] = Object.freeze([
  'RATE',
  'RATE_P1',
  'RATE_P25',
  'RATE_P75',
  'RATE_P99',
  'RATE_VOLUME_BN',
  'TARGET_FROM',
  'TARGET_TO',
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
]);

export const BTMM_CURVE_SUBJECTS = ['c:UST_PAR', 'c:UST_CMT', 'c:UST_BILL', 'c:SOFR_FIX'] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§BTMM "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const BTMM_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'label', label: 'Label', type: 'string' },
  { id: 'value', label: 'Value', type: 'number' },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'compareValue', label: 'Compare', type: 'number' },
  { id: 'chgBp', label: 'Change bp', type: 'number' },
  { id: 'asOfDate', label: 'As of', type: 'date' },
  { id: 'sourceId', label: 'Source', type: 'string' },
];

const numOf = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

/** `'SOFR'` → `'SOFR'`; a null-by-design cell gets its reason appended to the label (§BTMM CSV). */
const labelOf = (label: string, cell: ValueCell): string =>
  cell.v === null ? `${label} (—)` : label;

function btmmCsvRows(payload: BtmmPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  const p = payload.policy;
  rows.push([
    'policy',
    'TARGET_FROM',
    labelOf('Target range low', p.targetFrom),
    numOf(p.targetFrom),
    'pct',
    null,
    null,
    p.effectiveDate,
    'nyfed.rates',
  ]);
  rows.push([
    'policy',
    'TARGET_TO',
    labelOf('Target range high', p.targetTo),
    numOf(p.targetTo),
    'pct',
    null,
    null,
    p.effectiveDate,
    'nyfed.rates',
  ]);
  rows.push([
    'policy',
    'TARGET_MID',
    labelOf('Target range midpoint', p.targetMid),
    numOf(p.targetMid),
    'pct',
    null,
    null,
    p.effectiveDate,
    'nyfed.rates',
  ]);
  rows.push(['policy', 'IORB', `Interest on reserve balances (${NO_IORB_SOURCE})`, null, 'pct', null, null, null, '']);
  rows.push([
    'policy',
    'DISCOUNT_WINDOW',
    `Primary credit rate (${NO_DISCOUNT_WINDOW_SOURCE})`,
    null,
    'pct',
    null,
    null,
    null,
    '',
  ]);
  if (p.lastMeeting !== null) {
    rows.push([
      'policy',
      'LAST_FOMC',
      p.lastMeeting.meetingDate,
      p.lastMeeting.decisionBp,
      'bp',
      null,
      null,
      p.lastMeeting.meetingDate,
      'fed.fomc',
    ]);
  }
  if (p.nextMeeting !== null) {
    rows.push([
      'policy',
      'NEXT_FOMC',
      p.nextMeeting.meetingDate,
      p.nextMeeting.daysAway,
      'days',
      null,
      null,
      p.nextMeeting.meetingDate,
      'fed.fomc',
    ]);
  }
  for (const row of payload.overnight) {
    rows.push([
      'overnight',
      row.rateCode,
      labelOf(row.label, row.rate),
      numOf(row.rate),
      'pct',
      null,
      numOf(row.chg1dBp),
      row.effectiveDate,
      'nyfed.rates',
    ]);
  }
  for (const point of payload.bills.points) {
    rows.push([
      'bills',
      `${point.tenor}|${point.quoteType}`,
      labelOf(point.cusip ?? point.tenor, point.value),
      numOf(point.value),
      'pct',
      numOf(point.compareValue),
      numOf(point.chgBp),
      payload.bills.curveDate,
      'treasury.bills',
    ]);
  }
  for (const point of payload.curve.points) {
    rows.push([
      'curve',
      point.tenor,
      labelOf(point.fieldId ?? point.tenor, point.value),
      numOf(point.value),
      'pct',
      numOf(point.compareValue),
      numOf(point.chgBp),
      payload.curve.curveDate,
      payload.curve.curveId === 'UST_CMT' ? 'fed.h15' : 'treasury.yieldcurve',
    ]);
  }
  for (const spread of payload.spreads) {
    rows.push([
      'spreads',
      spread.id,
      labelOf(spread.definition, spread.value),
      numOf(spread.value),
      spread.unit,
      numOf(spread.compareValue),
      numOf(spread.chgBp),
      payload.curve.curveDate,
      'internal.derived',
    ]);
  }
  for (const row of [...payload.context.fx, ...payload.context.indices]) {
    const last = row.cells.PX_LAST;
    const chg = row.cells.CHG_NET_1D;
    rows.push([
      'context',
      row.key,
      last === undefined ? row.name : labelOf(row.name, last),
      last === undefined ? null : numOf(last),
      'px',
      null,
      chg === undefined ? null : numOf(chg),
      null,
      'cboe.quotes',
    ]);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const BTMM = defineFunction<typeof BtmmParams, BtmmPayload>({
  code: 'BTMM',
  name: 'Treasury & Money Markets',
  aliases: ['MMKT'],
  tier: 2,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: BtmmParams,
  paramGrammar: {
    positional: [{ name: 'section', type: 'enum', values: [...BtmmSections], optional: true }],
    keyed: {
      CMP: { name: 'compareDate', type: 'date' },
      U: { name: 'spreadUnits', type: 'enum', values: ['bp', 'pct'] },
      PCT: { name: 'percentiles', type: 'boolean' },
      CRV: { name: 'curveId', type: 'enum', values: [...BtmmCurveIds] },
    },
  },
  fieldIds: (): FieldId[] => monitorPrecheckFields(BTMM_PRECHECK_SUPERSET),
  pageable: false,
  live: (_params, payload): LiveSpec => ({
    subjects: [
      ...BTMM_RATE_CODES.map((code) => `r:${code}`),
      ...BTMM_CURVE_SUBJECTS,
      ...payload.context.fx.map((r) => r.subject),
      ...payload.context.indices.map((r) => r.subject),
    ],
    fields: [...BTMM_LIVE_FIELDS],
    conflationMs: 1000,
  }),
  csv: {
    filename: (_params, ctx): string =>
      `BTMM_${ctx.asOf.slice(0, 10).replace(/-/g, '')}_${ctx.asOf.replace(/[-:]/g, '')}.csv`,
    columns: BTMM_COLUMNS,
    rows: (payload): CsvDocument['rows'] => btmmCsvRows(payload),
  },
  help: {
    summary: 'Policy range, overnight rates, bills, the Treasury curve and spreads on one page',
    description:
      "BTMM is the rates desk's morning page. The policy block shows the FOMC target range as the " +
      'New York Fed publishes it with the EFFR fixing, the last and next meeting dates. The ' +
      'overnight block shows SOFR, EFFR, OBFR, TGCR and BGCR with their 1st, 25th, 75th and 99th ' +
      'percentiles and traded volume, plus the SOFR averages and index. Bills come from the ' +
      'Treasury daily bill rates file with the on-the-run CUSIP for each tenor; the curve block is ' +
      'the Treasury par yield curve or the Federal Reserve H.15 constant-maturity curve, with a ' +
      'basis-point change column against any earlier curve date (press D). Spreads are computed ' +
      'from those same published values, never from a second source. There is no interest on ' +
      'reserve balances, no discount-window rate and no fed funds futures in the reachable source ' +
      'set: those cells show a reason code, and the implied policy path is derived from the ' +
      'money-market curve in WIRP instead.',
    params: [
      {
        name: 'section',
        text: 'ALL, POLICY, OVERNIGHT, BILLS, CURVE, SPREADS or CONTEXT',
        example: 'BTMM CURVE',
      },
      { name: 'compareDate', text: 'curve date for the change column', example: 'CMP=2026-09-08' },
      { name: 'spreadUnits', text: 'bp or pct', example: 'U=pct' },
      { name: 'percentiles', text: 'show the percentile columns', example: 'PCT=0' },
      { name: 'curveId', text: 'UST_PAR or UST_CMT', example: 'CRV=UST_CMT' },
    ],
    keys: [
      { key: '1…7', action: 'section tabs' },
      { key: 'U', action: 'cycle bp / pct' },
      { key: 'C', action: 'cycle UST_PAR / UST_CMT' },
      { key: 'D', action: 'pick the compare curve date' },
      { key: 'P', action: 'toggle the percentile columns' },
      { key: 'W', action: 'WIRP — the implied policy path' },
    ],
    sources: [
      'nyfed.rates',
      'treasury.yieldcurve',
      'treasury.bills',
      'fed.h15',
      'fed.fomc',
      'cboe.quotes',
      'yahoo.chart',
    ],
    related: ['WIRP', 'CRVF', 'FED', 'YAS', 'SRCH', 'FXC', 'WB'],
  },
  keymap: [
    { key: '1', action: 'tab-section', description: 'All blocks' },
    { key: '2', action: 'tab-section', description: 'Policy' },
    { key: '3', action: 'tab-section', description: 'Overnight' },
    { key: '4', action: 'tab-section', description: 'Bills' },
    { key: '5', action: 'tab-section', description: 'Curve' },
    { key: '6', action: 'tab-section', description: 'Spreads' },
    { key: '7', action: 'tab-section', description: 'Context' },
    { key: 'U', action: 'cycle-spread-units', description: 'bp → pct → bp' },
    { key: 'C', action: 'cycle-curve', description: 'UST_PAR → UST_CMT → UST_PAR' },
    { key: 'D', action: 'set-compare-date', description: 'Compare to another curve date' },
    { key: 'P', action: 'toggle-percentiles', description: 'Show or hide the percentile columns' },
    { key: 'Enter', action: 'open-yas', when: 'grid', description: 'YAS for the focused bill' },
    {
      key: 'Shift+Enter',
      action: 'open-yas-next',
      when: 'grid',
      description: 'YAS for the focused bill in the next panel',
    },
    { key: 'G', action: 'open-gp', when: 'grid', description: 'Chart the focused row' },
    { key: 'V', action: 'open-crvf', description: 'Curve construction' },
    { key: 'W', action: 'open-wirp', description: 'The implied policy path' },
    { key: 'F', action: 'open-fed', description: 'Fed monitor' },
    { key: 'X', action: 'open-fxc', description: 'FX cross matrix' },
    { key: 'B', action: 'open-wb', description: 'World bond markets' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default BTMM;
