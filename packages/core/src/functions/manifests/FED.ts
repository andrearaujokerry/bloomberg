// packages/core/src/functions/manifests/FED.ts
//
// `FED` — Federal Reserve Monitor (FUNCTIONS_TIER3.md §FED, FUNCTIONS.md §6).
//
// The policy page: the target range and the overnight complex from the New York Fed, the H.15
// constant-maturity grid, the FOMC calendar with the overnight rate implied at each meeting by the
// `SOFR_OIS` curve, and the Federal Reserve press feed.
//
// **Four things Bloomberg's FED shows have no reachable source in this build, and every one of them
// is blank with a reason rather than derived.** This is the entry's defining property, so the
// reasons are declared here as constants and the resolver may not invent a number for any of them:
//
//  * **IORB** — published in the H.15 *selected daily rates* release; the H.15 slice fetched here is
//    the constant-maturity Treasury block only (BRIEF §2). It is **not** EFFR plus a spread.
//  * **The primary-credit (discount) rate** — no reachable keyless source.
//  * **The balance sheet** — H.4.1 is not among the verified keyless endpoints, so `balanceSheet`
//    is `null` and no block is rendered.
//  * **Hike and cut probabilities** — these need fed-funds futures, which are not reachable
//    (§0 `NO_FUTURES_SOURCE`). `meetings[].hikeProbPct` and `cutProbPct` are typed `null` so a
//    resolver cannot put a number there even by accident; what the calendar shows is an implied
//    *rate path*, which is a different claim and is labelled as one.
//
// Deviations from §FED, recorded here and in the resolver's header:
//
//  * **A null-by-design cell is `{ v: null, st: 'na', provIdx: -1 }` with the reason in
//    `meta.unavailable`**, not `{ …, r: 'NO_SOURCE_FIELD' }`. `ValueCell.r` is the closed
//    `ReasonCode` union (`core/types/entitlement.ts`) and `NO_SOURCE_FIELD` is not a member of it;
//    `r` means "this was refused", and nothing here was refused. BTMM, DES, GIP, RV and W all use
//    the same shape.
//  * **`data.news.search` takes one `feed`, not a `feeds` array** — that is WP-04's landed
//    `NewsQuery`, and the Fed press feed is a single feed (`press_all`).
//  * **The engine is `wirp.policypath@1.0.0`** (the landed `defineEngine` name).
//  * **`fieldIds()` is the plant-read subset**, for the reason BTMM.ts records at length: the
//    published curve ids are `eod`-capped licences and pre-checking them would seed the plant gate
//    for the whole run with `TIER_EOD`, for cells the gate never touches. {@link FED_FIELD_IDS} is
//    the full §FED list and is what the screen subscribes to.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { defineFunction, type CsvColumn, type CsvDocument, type LiveSpec } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§FED "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FedViews = ['rates', 'calendar', 'press'] as const;
export type FedView = (typeof FedViews)[number];

export const FedCategories = ['all', 'monetary', 'banking', 'other'] as const;
export type FedCategory = (typeof FedCategories)[number];

export const FedParams = z.object({
  view: z.enum(FedViews).default('rates'),
  /** Overnight-rate history rows. */
  histDays: z.number().int().min(1).max(60).default(10),
  /** FOMC rows, past and scheduled. */
  meetings: z.number().int().min(1).max(8).default(8),
  pressLimit: z.number().int().min(1).max(50).default(20),
  category: z.enum(FedCategories).default('all'),
  /** Compute the implied overnight path. */
  path: z.boolean().default(true),
});
export type FedParams = z.infer<typeof FedParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The four structural gaps
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FED_NO_IORB_SOURCE = 'NO_IORB_SOURCE';
export const FED_NO_DISCOUNT_RATE_SOURCE = 'NO_DISCOUNT_RATE_SOURCE';
export const FED_NO_BALANCE_SHEET_SOURCE = 'NO_BALANCE_SHEET_SOURCE';
export const FED_NO_FUTURES_SOURCE = 'NO_FUTURES_SOURCE';
export const FED_PROXY_CURVE = 'PROXY_CURVE';

export const FED_IORB_DETAIL =
  'IORB is published in H.15 selected daily rates; the H.15 slice fetched here is the ' +
  'constant-maturity Treasury block only (BRIEF §2)';
export const FED_DISCOUNT_DETAIL = 'no reachable keyless source for the discount window rate';
export const FED_BALANCE_SHEET_DETAIL =
  'H.4.1 is not among the verified keyless endpoints (BRIEF §2)';
export const FED_PROBABILITY_DETAIL =
  'no fed-funds futures source (CME FedWatch not reachable); the implied path is a rate path, ' +
  'not a probability distribution';

/** The tone-warn line the calendar tab renders under the grid. */
export const FED_PATH_NOTE =
  'Implied path from the SOFR OIS curve (proxy inputs); no fed-funds futures source, so no ' +
  'probabilities.';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§FED "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FED_RATE_CODES = ['EFFR', 'SOFR', 'OBFR', 'TGCR', 'BGCR'] as const;
export type FedRateCode = (typeof FED_RATE_CODES)[number];

export const FED_RATE_LABELS: Readonly<Record<FedRateCode, string>> = Object.freeze({
  EFFR: 'Effective Federal Funds Rate',
  SOFR: 'Secured Overnight Financing Rate',
  OBFR: 'Overnight Bank Funding Rate',
  TGCR: 'Tri-Party General Collateral Rate',
  BGCR: 'Broad General Collateral Rate',
});

export interface FedNextMeeting {
  meetingDate: string;
  statementAt: string | null;
  hasSep: boolean;
  businessDaysAway: number;
}

export interface FedPolicy {
  targetFrom: ValueCell;
  targetTo: ValueCell;
  effectiveDate: string | null;
  lastChange: { meetingDate: string; decisionBp: number } | null;
  nextMeeting: FedNextMeeting | null;
  /** Always null — see the file header. */
  iorb: ValueCell;
  discountPrimary: ValueCell;
  provIdx: number;
}

export interface FedRateRow {
  rateCode: FedRateCode;
  name: string;
  instrumentId: number | null;
  subject: string | null;
  effectiveDate: string;
  rate: ValueCell;
  p1: ValueCell;
  p25: ValueCell;
  p75: ValueCell;
  p99: ValueCell;
  volumeBn: ValueCell;
  chg1dBp: ValueCell;
  /** Spread to the target-range midpoint, basis points. */
  spreadToMidBp: ValueCell;
  provIdx: number;
}

export interface FedSofrAverages {
  effectiveDate: string | null;
  avg30d: ValueCell;
  avg90d: ValueCell;
  avg180d: ValueCell;
  indexValue: ValueCell;
  provIdx: number;
}

export interface FedHistoryRow {
  date: string;
  effr: number | null;
  sofr: number | null;
  obfr: number | null;
  tgcr: number | null;
  bgcr: number | null;
  targetFrom: number | null;
  targetTo: number | null;
}

export interface FedH15Row {
  tenor: string;
  tenorDays: number;
  yieldPct: ValueCell;
  chg1dBp: ValueCell;
}

export interface FedH15Block {
  curveDate: string | null;
  priorDate: string | null;
  provIdx: number;
  rows: FedH15Row[];
}

export interface FedMeetingRow {
  meetingDate: string;
  statementAt: string | null;
  hasSep: boolean;
  isPast: boolean;
  isNext: boolean;
  decisionBp: number | null;
  impliedRatePct: ValueCell;
  /**
   * §FED step 8's `(implied[i] − implied[i−1]) × 100`, taken as the successive difference of
   * `cumulativeMoveBp` so the two cells share one anchor: the first meeting's move equals its
   * cumulative move, and the column sums to the last cumulative exactly.
   */
  impliedMoveBp: ValueCell;
  /** `(implied[i] − spot) × 100`, measured from the SOFR fixing the path is anchored on. */
  cumulativeMoveBp: ValueCell;
  /** Structurally null: no fed-funds futures source (BRIEF §2). */
  hikeProbPct: null;
  cutProbPct: null;
  provIdx: number;
}

export interface FedPathBlock {
  engine: { name: string; version: string; inputsHash: string };
  curveId: 'SOFR_OIS';
  curveDate: string;
  buildId: number;
  spotRatePct: ValueCell;
  caveats: (typeof FED_PROXY_CURVE | typeof FED_NO_FUTURES_SOURCE)[];
}

export interface FedPressItem {
  newsId: number;
  headline: string;
  summary: string | null;
  category: string | null;
  publishedAt: string;
  url: string;
  kind: 'press_release' | 'fed_release';
  isCorrection: boolean;
  provIdx: number;
}

export interface FedPayload {
  variant: 'default';
  /** Valuation date, America/New_York. */
  asOfDate: string;
  policy: FedPolicy;
  rates: FedRateRow[];
  sofrAverages: FedSofrAverages;
  /** Newest first, ≤ `histDays`. */
  history: FedHistoryRow[];
  h15: FedH15Block;
  meetings: FedMeetingRow[];
  path: FedPathBlock | null;
  /** H.4.1 is not reachable (BRIEF §2). */
  balanceSheet: null;
  press: FedPressItem[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Press categories (§FED resolver step 9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `monetary` = categories containing this; `banking` = the regulatory feed; `other` = the rest. */
export const FED_MONETARY_CATEGORY = 'Monetary Policy';
export const FED_BANKING_CATEGORY = 'Banking and Consumer Regulatory Policy';

export function fedCategoryMatches(category: string | null, filter: FedCategory): boolean {
  if (filter === 'all') return true;
  const text = category ?? '';
  if (filter === 'monetary') return text.includes(FED_MONETARY_CATEGORY);
  if (filter === 'banking') return text.includes(FED_BANKING_CATEGORY);
  return !text.includes(FED_MONETARY_CATEGORY) && !text.includes(FED_BANKING_CATEGORY);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§FED "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The plant-read subset — see the file header for why the curve ids are not pre-checked. */
export const FED_PRECHECK_FIELDS: readonly FieldId[] = Object.freeze([
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

export const FED_FIELD_IDS: readonly FieldId[] = Object.freeze([
  ...FED_PRECHECK_FIELDS,
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
  'HEADLINE',
  'PUBLISHED_AT',
]);

export const FED_LIVE_FIELDS: readonly FieldId[] = Object.freeze([
  'RATE',
  'RATE_P1',
  'RATE_P25',
  'RATE_P75',
  'RATE_P99',
  'RATE_VOLUME_BN',
  'TARGET_FROM',
  'TARGET_TO',
  'HEADLINE',
  'PUBLISHED_AT',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§FED "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Long format (§1.6 rule 3 — five blocks).
 *
 * `value` is declared `string` because the column genuinely holds both kinds: a rate row puts a
 * number there and a press row puts the story's URL. `toCsv` serialises a number in a string column
 * identically (`serialiseCell`), so nothing is lost but the runner's numeric-column heuristic,
 * which a long-format export gives nothing to match against anyway.
 */
const FED_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'label', label: 'Label', type: 'string' },
  { id: 'value', label: 'Value', type: 'string' },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'asOf', label: 'As of', type: 'string' },
  { id: 'source', label: 'Source', type: 'string' },
];

const numOf = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

export function fedCsvRows(payload: FedPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  const push = (
    section: string,
    key: string,
    label: string,
    value: string | number | boolean | null,
    unit: string,
    asOf: string | null,
    source: string,
  ): void => {
    rows.push([section, key, label, value, unit, asOf, source]);
  };

  const p = payload.policy;
  push('policy', 'targetFrom', 'Target range low', numOf(p.targetFrom), 'pct', p.effectiveDate, 'nyfed.rates');
  push('policy', 'targetTo', 'Target range high', numOf(p.targetTo), 'pct', p.effectiveDate, 'nyfed.rates');
  push(
    'policy',
    'lastChangeBp',
    p.lastChange === null ? 'Last change' : `Last change ${p.lastChange.meetingDate}`,
    p.lastChange?.decisionBp ?? null,
    'bp',
    p.lastChange?.meetingDate ?? null,
    'fed.fomc',
  );
  push(
    'policy',
    'nextMeeting',
    'Next FOMC',
    p.nextMeeting?.meetingDate ?? null,
    'date',
    p.nextMeeting?.meetingDate ?? null,
    'fed.fomc',
  );
  push('policy', 'iorb', `Interest on reserve balances (${FED_NO_IORB_SOURCE})`, null, 'pct', null, '');
  push(
    'policy',
    'discountPrimary',
    `Primary credit rate (${FED_NO_DISCOUNT_RATE_SOURCE})`,
    null,
    'pct',
    null,
    '',
  );

  for (const row of payload.rates) {
    const cells: [string, ValueCell, string][] = [
      ['rate', row.rate, 'pct'],
      ['p1', row.p1, 'pct'],
      ['p25', row.p25, 'pct'],
      ['p75', row.p75, 'pct'],
      ['p99', row.p99, 'pct'],
      ['volumeBn', row.volumeBn, 'usd_bn'],
      ['chg1dBp', row.chg1dBp, 'bp'],
      ['spreadToMidBp', row.spreadToMidBp, 'bp'],
    ];
    for (const [field, cell, unit] of cells) {
      push('rate', `${row.rateCode}.${field}`, row.name, numOf(cell), unit, row.effectiveDate, 'nyfed.rates');
    }
  }

  const a = payload.sofrAverages;
  for (const [key, cell, unit] of [
    ['avg30d', a.avg30d, 'pct'],
    ['avg90d', a.avg90d, 'pct'],
    ['avg180d', a.avg180d, 'pct'],
    ['indexValue', a.indexValue, 'index'],
  ] as [string, ValueCell, string][]) {
    push('sofr_avg', key, 'SOFR averages and index', numOf(cell), unit, a.effectiveDate, 'nyfed.rates');
  }

  for (const row of payload.h15.rows) {
    push('h15', row.tenor, 'Constant maturity', numOf(row.yieldPct), 'pct', payload.h15.curveDate, 'fed.h15');
    push('h15', `${row.tenor}.chg`, 'Constant maturity change', numOf(row.chg1dBp), 'bp', payload.h15.curveDate, 'fed.h15');
  }

  for (const row of payload.history) {
    for (const [code, value] of [
      ['EFFR', row.effr],
      ['SOFR', row.sofr],
      ['OBFR', row.obfr],
      ['TGCR', row.tgcr],
      ['BGCR', row.bgcr],
    ] as [string, number | null][]) {
      push('history', `${row.date}.${code}`, code, value, 'pct', row.date, 'nyfed.rates');
    }
  }

  for (const m of payload.meetings) {
    push('fomc', m.meetingDate, 'Implied overnight rate', numOf(m.impliedRatePct), 'pct', m.meetingDate, 'internal.derived');
    push('fomc', `${m.meetingDate}.decisionBp`, 'Decision', m.decisionBp, 'bp', m.meetingDate, 'fed.fomc');
    push('fomc', `${m.meetingDate}.moveBp`, 'Implied move', numOf(m.impliedMoveBp), 'bp', m.meetingDate, 'internal.derived');
    push('fomc', `${m.meetingDate}.cumBp`, 'Cumulative move', numOf(m.cumulativeMoveBp), 'bp', m.meetingDate, 'internal.derived');
  }

  for (const item of payload.press) {
    push('press', String(item.newsId), item.headline, item.url, 'text', item.publishedAt, 'fed.rss');
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FED = defineFunction<typeof FedParams, FedPayload>({
  code: 'FED',
  name: 'Federal Reserve Monitor',
  aliases: ['FOMC'],
  aliasParams: { FOMC: { view: 'calendar' } },
  tier: 3,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: FedParams,
  paramGrammar: {
    positional: [{ name: 'view', type: 'enum', values: [...FedViews], optional: true }],
    keyed: {
      N: { name: 'histDays', type: 'number' },
      MTG: { name: 'meetings', type: 'number' },
      CAT: { name: 'category', type: 'enum', values: [...FedCategories] },
      PATH: { name: 'path', type: 'boolean' },
    },
  },
  fieldIds: (): FieldId[] => [...FED_PRECHECK_FIELDS],
  pageable: false,
  live: (): LiveSpec => ({
    subjects: [
      ...FED_RATE_CODES.map((code) => `r:${code}`),
      'c:SOFR_OIS',
      'n:topic:FED',
    ],
    fields: [...FED_LIVE_FIELDS],
    conflationMs: 1000,
  }),
  csv: {
    filename: (_params, ctx): string => `FED_${ctx.asOf.replace(/[-:]/g, '')}.csv`,
    columns: FED_COLUMNS,
    rows: (payload): CsvDocument['rows'] => fedCsvRows(payload),
  },
  help: {
    summary: 'Policy rates, H.15 curve, FOMC calendar with implied path, Fed press',
    description:
      'FED is the Federal Reserve page: the current target range and the overnight complex (EFFR, ' +
      'SOFR, OBFR, TGCR, BGCR) with their percentiles and volumes from the New York Fed, the SOFR ' +
      'averages and index, the H.15 constant-maturity Treasury grid with one-day changes, the ' +
      'FOMC calendar with the overnight rate implied at each meeting by the SOFR OIS curve, and ' +
      'the Federal Reserve press release feed. Interest on reserve balances, the primary-credit ' +
      'rate and the balance sheet have no reachable public source in this build and are shown ' +
      'blank with a reason; hike and cut probabilities need fed-funds futures, which are not ' +
      'available either, so the calendar shows an implied rate path and no probability ' +
      'distribution.',
    params: [
      { name: 'view', text: 'rates, calendar or press', example: 'FED PRESS' },
      { name: 'histDays', text: 'overnight history rows', example: 'N=20' },
      { name: 'meetings', text: 'FOMC rows', example: 'MTG=8' },
      { name: 'pressLimit', text: 'press items', example: '20' },
      { name: 'category', text: 'press category filter', example: 'CAT=MONETARY' },
      { name: 'path', text: 'compute the implied path', example: 'PATH=0' },
    ],
    keys: [
      { key: '1 / 2 / 3', action: 'rates / calendar / press' },
      { key: 'P', action: 'toggle the implied path' },
      { key: 'C', action: 'cycle the press category' },
      { key: 'N', action: 'prompt for the history length' },
      { key: 'W', action: 'WIRP — the implied policy path' },
    ],
    sources: ['nyfed.rates', 'fed.h15', 'fed.fomc', 'fed.rss', 'internal.derived'],
    related: ['WIRP', 'BTMM', 'GC', 'CRVF', 'ECO'],
  },
  keymap: [
    { key: '1', action: 'tab-rates', description: 'Rates' },
    { key: '2', action: 'tab-calendar', description: 'FOMC calendar' },
    { key: '3', action: 'tab-press', description: 'Press releases' },
    { key: 'P', action: 'toggle-path', description: 'Compute or drop the implied path' },
    { key: 'C', action: 'cycle-category', description: 'all → monetary → banking → other' },
    { key: 'N', action: 'hist-days-prompt', description: 'History days' },
    { key: 'Enter', action: 'open-gp', when: 'grid', description: 'Chart the focused rate' },
    {
      key: 'Shift+Enter',
      action: 'open-gp-next',
      when: 'grid',
      description: 'Chart the focused rate in the next panel',
    },
    { key: 'W', action: 'open-wirp', description: 'The implied policy path' },
    { key: 'B', action: 'open-btmm', description: 'Treasury & money markets' },
    { key: 'G', action: 'open-gc', description: 'The constant-maturity curve' },
    { key: 'K', action: 'open-crvf', description: 'The SOFR OIS curve' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default FED;
