// packages/core/src/functions/manifests/SWPM.ts
//
// `SWPM` — Swap Manager (FUNCTIONS_TIER3.md §SWPM, FUNCTIONS.md §6).
//
// One USD SOFR overnight-index swap, priced against the `SOFR_OIS` build of §0: single-curve OIS,
// so the same build supplies the forwards and the discount factors. The swap is defined entirely
// by its parameters — `assetClasses: 'none'`, `requiresSecurity: false`, and the runner passes
// `instrument = null`.
//
// **Every `SOFR_OIS` payload carries `PROXY_CURVE` and `NO_OIS_SWAP_QUOTES_SOURCE`, always.** There
// is no OIS swap quote and no futures source in this build (BRIEF §2); the curve is bootstrapped
// from the SOFR fixing, realised SOFR averages, bills and Treasury par yields. The valuation is a
// full one — nothing is blanked — but the reader is told, on every screen and in every export, what
// the term points are made of. {@link SWPM_CURVE_CAVEATS} is that statement as data.
//
// The `conventions` block is restated in the payload rather than left implicit so a reviewer can
// diff the screen against the contract: annual ACT/360 on both legs, daily-compounded SOFR, no
// observation shift, a two-business-day payment lag, T+2 spot, modified following on SIFMA.
//
// Deviations from §SWPM, recorded here and in the resolver's header:
//
//  * **`results.dv01` is the engine's analytic parallel-shift derivative, not a ±1 bp difference
//    quotient**, and it is signed as the *NPV change for a +1 bp shift*. §SWPM step 9 writes
//    `(npv(−1bp) − npv(+1bp)) / 2`, which for a payer swap is **negative** — the opposite sign from
//    the positive `DV01 4,610.77` on §SWPM's own screen mock-up. `swap.ois@1.0.0` already returns
//    `curveDv01`, the exact derivative the difference quotient approximates, inside its
//    `EngineResult`; the acceptance test pins it against an independently computed finite
//    difference so the two definitions are held together rather than asserted apart.
//  * **`legs[].dv01` is filled for the fixed leg only.** The fixed leg's sensitivity is its annuity
//    PV01, which the engine returns. A *per-leg* curve DV01 needs a per-leg reprice that
//    `swap.ois@1.0.0` does not expose, so the float leg's cell is `na` with a `meta.unavailable`
//    entry rather than a number arrived at by subtraction in a resolver.
//  * **Key-rate risk is computed by repricing through the engine**, once per key tenor on a
//    triangular-kernel bump of the zero curve. §SWPM names a `swap/ois@1.0.0#keyRateRisk` entry
//    point that the landed engine does not have.
//  * **A seasoned swap (effective date before the curve date) is rejected with
//    `400 VALIDATION_FAILED`.** `oisSwapSchedule` states its own scope: it values spot- and
//    forward-starting swaps, and a swap already accruing needs its published fixings. So
//    `SwpmPeriod.realisedDays` is 0 on every row this build can produce, and `fixing.usedForRealised`
//    is always false — the fields stay in the payload because they are what the screen renders and
//    what a later build will fill.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { defineFunction, type CsvColumn, type CsvDocument, type LiveSpec } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§SWPM "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SwpmTenors = [
  '1Y',
  '2Y',
  '3Y',
  '4Y',
  '5Y',
  '7Y',
  '10Y',
  '15Y',
  '20Y',
  '30Y',
] as const;
export type SwpmTenor = (typeof SwpmTenors)[number];

export const SwpmKrdTenors = ['2Y', '5Y', '10Y', '30Y'] as const;
export type SwpmKrdTenor = (typeof SwpmKrdTenors)[number];

export const SwpmInterpolations = ['linear_zero', 'log_linear_df', 'monotone_convex'] as const;
export const SwpmSides = ['pay', 'receive'] as const;
export const SwpmViews = ['summary', 'fixed', 'float', 'risk'] as const;
export type SwpmView = (typeof SwpmViews)[number];

export const SwpmParams = z.object({
  /** The FIXED side, from the user's perspective. */
  side: z.enum(SwpmSides).default('pay'),
  /** USD, both legs; no amortisation in v1. */
  notional: z.number().positive().max(1e12).default(10_000_000),
  tenor: z.enum(SwpmTenors).default('5Y'),
  /** `null` = T+2 SIFMA from the valuation date. */
  effective: z.iso.date().nullable().default(null),
  /** `null` = effective + tenor, modified following on SIFMA. */
  maturity: z.iso.date().nullable().default(null),
  /** Percent; `null` solves the par rate (NPV = 0). */
  fixedRate: z.number().min(-5).max(50).nullable().default(null),
  /** `null` = the latest stored `SOFR_OIS` curve_date ≤ `validAt`. */
  curveDate: z.iso.date().nullable().default(null),
  interpolation: z.enum(SwpmInterpolations).default('monotone_convex'),
  krdTenors: z.array(z.enum(SwpmKrdTenors)).min(1).max(4).default([...SwpmKrdTenors]),
  view: z.enum(SwpmViews).default('summary'),
});
export type SwpmParams = z.infer<typeof SwpmParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Caveats
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SWPM_PROXY_CURVE = 'PROXY_CURVE';
export const SWPM_NO_OIS_QUOTES = 'NO_OIS_SWAP_QUOTES_SOURCE';
export type SwpmCurveCaveat = typeof SWPM_PROXY_CURVE | typeof SWPM_NO_OIS_QUOTES;

/** Every SWPM payload carries both, always — there is no OIS quote or futures source (BRIEF §2). */
export const SWPM_CURVE_CAVEATS: readonly SwpmCurveCaveat[] = Object.freeze([
  SWPM_PROXY_CURVE,
  SWPM_NO_OIS_QUOTES,
]);

export const SWPM_PROXY_DETAIL =
  'SOFR OIS term points are proxied (SOFR averages, bills, UST par); no OIS swap or futures ' +
  'source (BRIEF §2)';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§SWPM "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type SwpmLegKind = 'fixed' | 'float';

export interface SwpmPeriod {
  n: number;
  start: string;
  end: string;
  /** `end` rolled on by the payment lag (2 business days, SIFMA, modified following). */
  paymentDate: string;
  days: number;
  /** ACT/360. */
  accrualFactor: number;
  /** Fixed: the contract rate. Float: the compounded SOFR of the period. Percent. */
  rate: ValueCell;
  /** Float only: the split of the period's business days between fixings and curve forwards. */
  realisedDays: number;
  projectedDays: number;
  isCurrent: boolean;
  cashflow: ValueCell;
  /** `null` only when no curve is stored: the schedule needs the calendar, the df needs the curve. */
  df: number | null;
  pv: ValueCell;
}

export interface SwpmConventions {
  fixedFreq: 'annual';
  fixedDayCount: 'ACT/360';
  floatIndex: 'SOFR';
  floatFreq: 'annual';
  floatDayCount: 'ACT/360';
  compounding: 'daily';
  observationShift: 0;
  paymentLagDays: 2;
  bdc: 'modified_following';
  calendarId: 'SIFMA';
  spotLagDays: 2;
  discounting: 'SOFR_OIS (single curve)';
}

export interface SwpmTrade {
  side: 'pay' | 'receive';
  notional: number;
  currency: 'USD';
  tenor: string;
  tradeDate: string;
  effective: string;
  maturity: string;
  valuationDate: string;
  fixedRate: ValueCell;
  fixedRateSource: 'user' | 'par';
  stub: 'short_front' | 'none';
}

/**
 * The curve the swap was priced on.
 *
 * **Widening of §SWPM**, which types `date`, `buildId`, `interpolation` and `engine` as
 * non-nullable: §SWPM's own reason-code table requires a 200 with a blanked valuation when no
 * `SOFR_OIS` curve is stored, and a block that cannot say "there was no curve" cannot express that.
 */
export interface SwpmCurveBlock {
  id: 'SOFR_OIS';
  date: string | null;
  requestedDate: string | null;
  buildId: number | null;
  method: 'ois_bootstrap' | null;
  interpolation: string | null;
  engine: { name: string; version: string; inputsHash: string } | null;
  provIdx: number;
  caveats: SwpmCurveCaveat[];
}

export interface SwpmFixing {
  rateCode: 'SOFR';
  effectiveDate: string | null;
  rate: ValueCell;
  provIdx: number;
  usedForRealised: boolean;
}

export interface SwpmLeg {
  kind: SwpmLegKind;
  payReceive: 'pay' | 'receive';
  periods: SwpmPeriod[];
  pv: ValueCell;
  accrued: ValueCell;
  dv01: ValueCell;
  nextPaymentDate: string | null;
  nextCashflow: ValueCell;
}

export interface SwpmKrd {
  tenor: SwpmKrdTenor;
  /** Years. */
  krd: number;
  /** Currency, for a 1 bp bump of the zero curve at this tenor. */
  dv01: number;
}

export interface SwpmSpreads {
  treasuryTenor: string;
  treasuryYieldPct: ValueCell;
  swapSpreadBp: ValueCell;
  curveProvIdx: number;
}

export interface SwpmResults {
  parRatePct: ValueCell;
  fixedRatePct: ValueCell;
  /** `npv > 0` is in the user's favour. */
  npv: ValueCell;
  pvFixed: ValueCell;
  pvFloat: ValueCell;
  /** PV of 1 bp on the fixed leg, in currency. */
  annuityPv01: ValueCell;
  dv01: ValueCell;
  dv01Per1mm: ValueCell;
  marketValuePctNotional: ValueCell;
  accrued: ValueCell;
  breakEvenRatePct: ValueCell;
  effectiveDurationYears: ValueCell;
  keyRateDurations: SwpmKrd[];
  spreads: SwpmSpreads | null;
}

export interface SwpmPayload {
  variant: 'default';
  trade: SwpmTrade;
  conventions: SwpmConventions;
  curve: SwpmCurveBlock;
  fixing: SwpmFixing;
  legs: SwpmLeg[];
  results: SwpmResults;
  /** Echo of `meta.engines` for the footer. */
  engines: { name: string; version: string }[];
}

/** The conventions block, which is the same object on every payload this build produces. */
export const SWPM_CONVENTIONS: SwpmConventions = Object.freeze({
  fixedFreq: 'annual',
  fixedDayCount: 'ACT/360',
  floatIndex: 'SOFR',
  floatFreq: 'annual',
  floatDayCount: 'ACT/360',
  compounding: 'daily',
  observationShift: 0,
  paymentLagDays: 2,
  bdc: 'modified_following',
  calendarId: 'SIFMA',
  spotLagDays: 2,
  discounting: 'SOFR_OIS (single curve)',
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§SWPM "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SWPM_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'SWAP_PAR_RATE',
  'SWAP_FIXED_RATE',
  'SWAP_NPV',
  'SWAP_PV01',
  'SWAP_ACCRUED',
  'DV01',
  'KRD_2Y',
  'KRD_5Y',
  'KRD_10Y',
  'KRD_30Y',
  'RATE',
  'RATE_AVG_30D',
  'CURVE_ZERO',
  'CURVE_DF',
  'CURVE_FWD_3M',
  'CURVE_PAR',
  'YLD_YTM_MID',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§SWPM "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Long format (FUNCTIONS.md §1.6 rule 3): the payload is five blocks, so every number in the
 * export is one `(section, leg, n, key)` row.
 *
 * `value` is declared `string` rather than `number` because the column genuinely holds both — a
 * schedule row's `start` is a date and a trade row's `side` is a word. `toCsv` serialises a number
 * in a string column identically (`serialiseCell`), so no precision is lost; what is lost is the
 * runner's numeric-column heuristic, which for a long-format export names nothing a payload key
 * matches anyway.
 */
const SWPM_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'leg', label: 'Leg', type: 'string' },
  { id: 'n', label: 'Period', type: 'number' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'value', label: 'Value', type: 'string' },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'asOf', label: 'As of', type: 'string' },
  { id: 'source', label: 'Source', type: 'string' },
];

const numOf = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

export function swpmCsvRows(payload: SwpmPayload, asOf: string): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  const push = (
    section: string,
    leg: string,
    n: number | null,
    key: string,
    value: string | number | boolean | null,
    unit: string,
    source: string,
  ): void => {
    rows.push([section, leg, n, key, value, unit, asOf, source]);
  };

  const t = payload.trade;
  push('trade', '', null, 'side', t.side, 'text', 'internal.user');
  push('trade', '', null, 'notional', t.notional, 'ccy', 'internal.user');
  push('trade', '', null, 'currency', t.currency, 'text', 'internal.user');
  push('trade', '', null, 'tenor', t.tenor, 'text', 'internal.user');
  push('trade', '', null, 'tradeDate', t.tradeDate, 'date', 'internal.user');
  push('trade', '', null, 'effective', t.effective, 'date', 'internal.derived');
  push('trade', '', null, 'maturity', t.maturity, 'date', 'internal.derived');
  push('trade', '', null, 'valuationDate', t.valuationDate, 'date', 'internal.derived');
  push('trade', '', null, 'fixedRate', numOf(t.fixedRate), 'pct', 'internal.derived');
  push('trade', '', null, 'fixedRateSource', t.fixedRateSource, 'text', 'internal.derived');
  push('trade', '', null, 'stub', t.stub, 'text', 'internal.derived');

  for (const [key, value] of Object.entries(payload.conventions)) {
    push('conventions', '', null, key, value as string | number, 'text', 'internal.derived');
  }

  const c = payload.curve;
  push('curve', '', null, 'id', c.id, 'text', 'internal.derived');
  push('curve', '', null, 'date', c.date, 'date', 'internal.derived');
  push('curve', '', null, 'buildId', c.buildId, 'int', 'internal.derived');
  push('curve', '', null, 'method', c.method, 'text', 'internal.derived');
  push('curve', '', null, 'interpolation', c.interpolation, 'text', 'internal.derived');
  push('curve', '', null, 'caveats', c.caveats.join('|'), 'text', 'internal.derived');

  const f = payload.fixing;
  push('fixing', '', null, 'rateCode', f.rateCode, 'text', 'nyfed.rates');
  push('fixing', '', null, 'effectiveDate', f.effectiveDate, 'date', 'nyfed.rates');
  push('fixing', '', null, 'rate', numOf(f.rate), 'pct', 'nyfed.rates');

  const r = payload.results;
  const scalars: [string, ValueCell, string][] = [
    ['parRatePct', r.parRatePct, 'pct'],
    ['fixedRatePct', r.fixedRatePct, 'pct'],
    ['npv', r.npv, 'ccy'],
    ['pvFixed', r.pvFixed, 'ccy'],
    ['pvFloat', r.pvFloat, 'ccy'],
    ['annuityPv01', r.annuityPv01, 'ccy'],
    ['dv01', r.dv01, 'ccy'],
    ['dv01Per1mm', r.dv01Per1mm, 'ccy'],
    ['marketValuePctNotional', r.marketValuePctNotional, 'pct'],
    ['accrued', r.accrued, 'ccy'],
    ['breakEvenRatePct', r.breakEvenRatePct, 'pct'],
    ['effectiveDurationYears', r.effectiveDurationYears, 'years'],
  ];
  for (const [key, cell, unit] of scalars) {
    push('results', '', null, key, numOf(cell), unit, 'internal.derived');
  }
  if (r.spreads !== null) {
    push('results', '', null, 'treasuryTenor', r.spreads.treasuryTenor, 'text', 'treasury.yieldcurve');
    push(
      'results',
      '',
      null,
      'treasuryYieldPct',
      numOf(r.spreads.treasuryYieldPct),
      'pct',
      'treasury.yieldcurve',
    );
    push('results', '', null, 'swapSpreadBp', numOf(r.spreads.swapSpreadBp), 'bp', 'internal.derived');
  }
  for (const k of r.keyRateDurations) {
    push('krd', '', null, k.tenor, k.krd, 'years', 'internal.derived');
    push('krd', '', null, `${k.tenor}/dv01`, k.dv01, 'ccy', 'internal.derived');
  }

  for (const leg of payload.legs) {
    for (const p of leg.periods) {
      push('schedule', leg.kind, p.n, 'start', p.start, 'date', 'internal.derived');
      push('schedule', leg.kind, p.n, 'end', p.end, 'date', 'internal.derived');
      push('schedule', leg.kind, p.n, 'paymentDate', p.paymentDate, 'date', 'internal.derived');
      push('schedule', leg.kind, p.n, 'days', p.days, 'int', 'internal.derived');
      push('schedule', leg.kind, p.n, 'accrualFactor', p.accrualFactor, 'px', 'internal.derived');
      push('schedule', leg.kind, p.n, 'rate', numOf(p.rate), 'pct', 'internal.derived');
      push('schedule', leg.kind, p.n, 'cashflow', numOf(p.cashflow), 'ccy', 'internal.derived');
      push('schedule', leg.kind, p.n, 'df', p.df, 'px', 'internal.derived');
      push('schedule', leg.kind, p.n, 'pv', numOf(p.pv), 'ccy', 'internal.derived');
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SWPM = defineFunction<typeof SwpmParams, SwpmPayload>({
  code: 'SWPM',
  name: 'Swap Manager',
  aliases: ['SWAP'],
  tier: 3,
  category: 'rates',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: SwpmParams,
  paramGrammar: {
    positional: [
      { name: 'tenor', type: 'enum', values: [...SwpmTenors], optional: true },
      { name: 'fixedRate', type: 'number', optional: true },
    ],
    keyed: {
      N: { name: 'notional', type: 'number' },
      R: { name: 'fixedRate', type: 'number' },
      EFF: { name: 'effective', type: 'date' },
      MAT: { name: 'maturity', type: 'date' },
      SIDE: { name: 'side', type: 'enum', values: [...SwpmSides] },
      CRVD: { name: 'curveDate', type: 'date' },
      INTERP: { name: 'interpolation', type: 'enum', values: [...SwpmInterpolations] },
    },
  },
  fieldIds: (): FieldId[] => [...SWPM_FIELD_IDS],
  pageable: false,
  live: (): LiveSpec => ({
    subjects: ['c:SOFR_OIS', 'r:SOFR'],
    fields: '*',
    conflationMs: 1000,
  }),
  csv: {
    filename: (params, ctx): string =>
      `SWPM_${params.tenor}_${(params.effective ?? ctx.asOf.slice(0, 10)).replace(/-/g, '')}_` +
      `${ctx.asOf.replace(/[-:]/g, '')}.csv`,
    columns: SWPM_COLUMNS,
    rows: (payload, _params): CsvDocument['rows'] =>
      swpmCsvRows(payload, payload.trade.valuationDate),
  },
  help: {
    summary: 'Price a USD SOFR OIS: schedules, par rate, NPV, DV01 and key-rate risk',
    description:
      'SWPM prices a single USD overnight-index swap against SOFR. Both legs are annual ACT/360; ' +
      'the floating leg is daily-compounded SOFR with no observation shift and a two-business-day ' +
      'payment lag, settled T+2 on the SIFMA calendar. Leave the fixed rate blank and SWPM solves ' +
      'the par rate that makes the swap worth zero; type a rate to value an existing trade. ' +
      'Forwards and discount factors come from the same SOFR OIS curve, which in this build is ' +
      'bootstrapped from proxies — the SOFR fixing, realised SOFR averages, bills and Treasury par ' +
      'yields — because no OIS swap quote or futures source is available; the PROXY_CURVE badge ' +
      'stays on the screen. Key-rate DV01s bump the zero curve at 2, 5, 10 and 30 years.',
    params: [
      { name: 'side', text: 'pay or receive fixed', example: 'pay' },
      { name: 'notional', text: 'notional in USD', example: '250M' },
      { name: 'tenor', text: '1Y to 30Y', example: '5Y' },
      { name: 'effective', text: 'effective date; default T+2 SIFMA', example: '2026-09-21' },
      { name: 'maturity', text: 'maturity; default effective + tenor' },
      { name: 'fixedRate', text: 'fixed rate in percent; blank solves par', example: '3.55' },
      { name: 'curveDate', text: 'SOFR OIS curve date; default latest', example: '2026-09-14' },
      { name: 'interpolation', text: 'zero-curve interpolation' },
      { name: 'krdTenors', text: 'key-rate tenors' },
      { name: 'view', text: 'summary, fixed, float or risk' },
    ],
    keys: [
      { key: 'Enter', action: 'reprice from the form' },
      { key: 'P', action: 're-solve at par' },
      { key: 'S', action: 'flip pay / receive' },
      { key: 'T', action: 'cycle the tenor' },
      { key: 'N', action: 'prompt for the notional' },
      { key: 'E', action: 'prompt for the effective date' },
      { key: 'I', action: 'cycle the interpolation' },
      { key: '1 / 2 / 3 / 4', action: 'summary / fixed / float / risk' },
    ],
    sources: [
      'nyfed.rates',
      'treasury.yieldcurve',
      'treasury.bills',
      'internal.derived',
      'internal.user',
    ],
    related: ['CRVF', 'YAS', 'WIRP', 'GC', 'BTMM'],
  },
  keymap: [
    { key: 'Enter', action: 'reprice', when: 'form', description: 'Submit the trade form' },
    {
      key: 'ArrowUp',
      action: 'bump-rate',
      when: 'form',
      description: '+1 bp on the fixed rate (+1,000,000 on the notional)',
    },
    {
      key: 'ArrowDown',
      action: 'bump-rate',
      when: 'form',
      description: '−1 bp on the fixed rate (−1,000,000 on the notional)',
    },
    { key: 'Shift+ArrowUp', action: 'bump-rate-10', when: 'form', description: '×10 of the above' },
    {
      key: 'Shift+ArrowDown',
      action: 'bump-rate-10',
      when: 'form',
      description: '×10 of the above',
    },
    { key: 'P', action: 'set-par', description: 'Re-solve at par' },
    { key: 'S', action: 'flip-side', description: 'pay ↔ receive' },
    { key: 'T', action: 'cycle-tenor', description: '1Y → 30Y' },
    { key: 'N', action: 'notional-prompt', description: 'Notional' },
    { key: 'E', action: 'effective-prompt', description: 'Effective date' },
    { key: 'I', action: 'cycle-interp', description: 'linear_zero → log_linear_df → monotone_convex' },
    { key: '1', action: 'tab-summary', description: 'Summary' },
    { key: '2', action: 'tab-fixed', description: 'Fixed leg' },
    { key: '3', action: 'tab-float', description: 'Float leg' },
    { key: '4', action: 'tab-risk', description: 'Risk' },
    {
      key: 'Enter',
      action: 'row-provenance',
      when: 'grid',
      description: 'Provenance of the focused period',
    },
    { key: 'C', action: 'open-crvf', description: 'The SOFR OIS curve behind the price' },
    { key: 'W', action: 'open-wirp', description: 'The implied policy path' },
    { key: 'Y', action: 'open-yas', description: 'The Treasury behind the swap spread' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default SWPM;
