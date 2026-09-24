// packages/core/src/functions/manifests/SRCH.ts
//
// `SRCH` — Treasury Search (FUNCTIONS_TIER3.md §SRCH L1302-1558, FUNCTIONS.md §6).
//
// SRCH screens the fixed-income universe of this build — US Treasuries — by **terms and
// conditions**: security type, maturity window, coupon window, benchmark status, callability,
// amount outstanding and CUSIP. It is deliberately not a price screen. There is no evaluated
// fixed-income pricing vendor here (BRIEF §1 non-goals, DATA-04), so every yield, price, accrued
// and duration column is derived from the Treasury curve by the engines YAS uses, the payload says
// so in `pricing.basis = 'curve_derived_no_market_quotes'`, and the note `NO_BOND_PRICE_SOURCE` is
// on every payload. A row's number therefore equals the YAS screen's number for the same security
// and settlement (ANAL-09) — the alternative, a screen with a "price" column of its own devising,
// would be two answers to one question.
//
// Two lists, and the difference between them matters:
//
//  - `columns` is what the user picked, out of a fixed whitelist; every entry becomes a cell on
//    every row, so a `na` cell (a bill's `ACCRUED`, a coupon bond's `DISC_RATE`) is a real answer
//    and not a hole.
//  - `fieldIds()` is the entitlement pre-check set. It is the whole whitelist rather than the
//    chosen columns so a firm without the curve grant is told once, not once per column (ENTL-05).
//
// The universe is `SEED_UNIVERSE_ONLY` and says so permanently: this build has the Treasury bill
// file and a curated set of on-the-run notes and bonds, not an issuance file. Corporates, munis and
// mortgages are out of the wedge — `market` is a one-value enum, so asking for them is a validation
// error rather than an empty screen that implies the search ran.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import type { CsvColumn } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { SortSpec } from '../schemas.js';
import { parseScreenNumber } from './EQS.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Columns (§SRCH "Params" whitelist and "Screen" formats)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SRCH_COLUMN_IDS = [
  'CUSIP',
  'SECURITY_TYP',
  'TERM_LABEL',
  'CPN',
  'CPN_FREQ',
  'MATURITY',
  'ISSUE_DT',
  'MTY_YEARS',
  'YLD_YTM_MID',
  'DISC_RATE',
  'BEY',
  'PX_CLEAN_MID',
  'PX_DIRTY_MID',
  'ACCRUED',
  'DUR_ADJ_MID',
  'DV01',
  'AMT_OUTSTANDING',
  'ON_THE_RUN',
  'DAY_CNT_DES',
] as const;
export type SrchColumnId = (typeof SRCH_COLUMN_IDS)[number];

export type SrchColumnFmt = 'px' | 'pct' | 'bp' | 'int' | 'ccy' | 'date' | 'text';

export interface SrchColumnDef {
  id: SrchColumnId;
  label: string;
  fmt: SrchColumnFmt;
  decimals?: number;
  /**
   * The dictionary field the column reports, when one exists.
   *
   * **Deviation from §SRCH's "Field ids introduced by this entry", reported rather than patched.**
   * That section asks for four new dictionary ids — `TERM_LABEL`, `ON_THE_RUN`, `AMT_OUTSTANDING`
   * and `PX_CLEAN_MID`. The landed `core/fields/dictionary.ts` already carries `ON_THE_RUN`,
   * `AMT_OUTSTANDING` and `PX_CLEAN_MID`; it has no `TERM_LABEL`, no `MTY_YEARS` and no
   * `DAY_CNT_DES`/`CUSIP` (it spells the last two `DAY_CNT` and `ID_CUSIP`). `fields/defs/**` is
   * not this work package's file to edit, so the three columns with no dictionary entry carry no
   * `fieldId` — a column id is a screen concept and does not have to be a field id — and the two
   * that are spelled differently cite the landed spelling.
   */
  fieldId?: FieldId;
}

/** The whole column catalogue: label, format and the dictionary field each column reports. */
export const SRCH_COLUMNS: Readonly<Record<SrchColumnId, SrchColumnDef>> = Object.freeze({
  CUSIP: { id: 'CUSIP', label: 'CUSIP', fmt: 'text', fieldId: 'ID_CUSIP' },
  SECURITY_TYP: { id: 'SECURITY_TYP', label: 'Type', fmt: 'text', fieldId: 'SECURITY_TYP' },
  TERM_LABEL: { id: 'TERM_LABEL', label: 'Term', fmt: 'text' },
  CPN: { id: 'CPN', label: 'Cpn %', fmt: 'pct', decimals: 3, fieldId: 'CPN' },
  CPN_FREQ: { id: 'CPN_FREQ', label: 'Freq', fmt: 'int', fieldId: 'CPN_FREQ' },
  MATURITY: { id: 'MATURITY', label: 'Maturity', fmt: 'date', fieldId: 'MATURITY' },
  ISSUE_DT: { id: 'ISSUE_DT', label: 'Issued', fmt: 'date', fieldId: 'ISSUE_DT' },
  MTY_YEARS: { id: 'MTY_YEARS', label: 'Yrs', fmt: 'px', decimals: 2 },
  YLD_YTM_MID: { id: 'YLD_YTM_MID', label: 'Yld %', fmt: 'pct', decimals: 3, fieldId: 'YLD_YTM_MID' },
  DISC_RATE: { id: 'DISC_RATE', label: 'Disc %', fmt: 'pct', decimals: 3, fieldId: 'DISC_RATE' },
  BEY: { id: 'BEY', label: 'BEY %', fmt: 'pct', decimals: 3, fieldId: 'BEY' },
  PX_CLEAN_MID: {
    id: 'PX_CLEAN_MID',
    label: 'Clean px',
    fmt: 'px',
    decimals: 6,
    fieldId: 'PX_CLEAN_MID',
  },
  PX_DIRTY_MID: {
    id: 'PX_DIRTY_MID',
    label: 'Dirty px',
    fmt: 'px',
    decimals: 6,
    fieldId: 'PX_DIRTY_MID',
  },
  ACCRUED: { id: 'ACCRUED', label: 'Accrued', fmt: 'px', decimals: 6, fieldId: 'ACCRUED' },
  DUR_ADJ_MID: {
    id: 'DUR_ADJ_MID',
    label: 'Mod dur',
    fmt: 'px',
    decimals: 3,
    fieldId: 'DUR_ADJ_MID',
  },
  DV01: { id: 'DV01', label: 'DV01', fmt: 'ccy', decimals: 2, fieldId: 'DV01' },
  AMT_OUTSTANDING: {
    id: 'AMT_OUTSTANDING',
    label: 'Amt outstanding',
    fmt: 'ccy',
    decimals: 0,
    fieldId: 'AMT_OUTSTANDING',
  },
  ON_THE_RUN: { id: 'ON_THE_RUN', label: 'OTR', fmt: 'text', fieldId: 'ON_THE_RUN' },
  DAY_CNT_DES: { id: 'DAY_CNT_DES', label: 'Day count', fmt: 'text', fieldId: 'DAY_CNT' },
});

/** The columns that come out of `govt_terms` — `st:'closed'`, cited to the terms row (§0.4 rule 3). */
export const SRCH_TERMS_COLUMNS: ReadonlySet<SrchColumnId> = new Set<SrchColumnId>([
  'CUSIP',
  'SECURITY_TYP',
  'TERM_LABEL',
  'CPN',
  'CPN_FREQ',
  'MATURITY',
  'ISSUE_DT',
  'MTY_YEARS',
  'AMT_OUTSTANDING',
  'ON_THE_RUN',
  'DAY_CNT_DES',
]);

/** The columns an engine produces from the curve — cited to the curve, engine in `meta.engines`. */
export const SRCH_ANALYTIC_COLUMNS: ReadonlySet<SrchColumnId> = new Set<SrchColumnId>(
  SRCH_COLUMN_IDS.filter((id) => !SRCH_TERMS_COLUMNS.has(id)),
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§SRCH "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SRCH_SECURITY_TYPES = ['bill', 'note', 'bond', 'tips', 'frn'] as const;
export type SrchSecurityType = (typeof SRCH_SECURITY_TYPES)[number];

export const SRCH_COUPON_TYPES = ['fixed', 'zero', 'float', 'step', 'inflation_linked'] as const;
export type SrchCouponType = (typeof SRCH_COUPON_TYPES)[number];

export const SRCH_DEFAULT_COLUMNS: readonly SrchColumnId[] = Object.freeze([
  'CUSIP',
  'SECURITY_TYP',
  'TERM_LABEL',
  'CPN',
  'MATURITY',
  'MTY_YEARS',
  'YLD_YTM_MID',
  'DUR_ADJ_MID',
  'ON_THE_RUN',
] as SrchColumnId[]);

/** The persisted shape of `saved_searches.query` when `kind = 'srch'` (DATA_MODEL §14). */
export const SrchCriteria = z.object({
  market: z.enum(['UST']).default('UST'),
  securityTypes: z
    .array(z.enum(SRCH_SECURITY_TYPES))
    .min(1)
    .max(5)
    .default(['bill', 'note', 'bond']),
  maturityFrom: z.iso.date().nullable().default(null),
  maturityTo: z.iso.date().nullable().default(null),
  yearsFrom: z.number().min(0).max(40).nullable().default(null),
  yearsTo: z.number().min(0).max(40).nullable().default(null),
  couponFrom: z.number().min(0).max(25).nullable().default(null),
  couponTo: z.number().min(0).max(25).nullable().default(null),
  couponTypes: z.array(z.enum(SRCH_COUPON_TYPES)).min(1).max(5).default(['fixed', 'zero']),
  onTheRun: z.enum(['any', 'only', 'exclude']).default('any'),
  callable: z.enum(['any', 'only', 'exclude']).default('any'),
  minAmountOutstanding: z.number().min(0).nullable().default(null),
  cusip: z
    .string()
    .regex(/^[0-9A-Z]{1,9}$/)
    .nullable()
    .default(null),
  columns: z
    .array(z.enum(SRCH_COLUMN_IDS))
    .min(1)
    .max(12)
    .default([...SRCH_DEFAULT_COLUMNS]),
  sort: SortSpec.default({ col: 'MATURITY', dir: 'asc' }),
});
export type SrchCriteria = z.infer<typeof SrchCriteria>;

export const SrchParams = SrchCriteria.extend({
  pageSize: z.number().int().min(10).max(200).default(50),
  /** `null` = T+1 on the SIFMA calendar from the valuation date. */
  settlement: z.iso.date().nullable().default(null),
  curveId: z.enum(['UST_PAR', 'UST_CMT']).default('UST_PAR'),
  /** `null` = the latest stored `curve_date ≤ validAt`. */
  curveDate: z.iso.date().nullable().default(null),
  savedSearchId: z.number().int().nullable().default(null),
});
export type SrchParams = z.infer<typeof SrchParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The criteria mini-language (§SRCH "Argument grammar")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SrchCriteriaProblem {
  code: 'ARG_PARSE';
  term: string;
  message: string;
}

export interface ParsedSrchCriteria {
  /** The criteria the text sets, ready to merge over the parsed params. */
  patch: Partial<SrchCriteria>;
  problems: SrchCriteriaProblem[];
}

/**
 * `'MTY_YEARS=2..10 CPN>4 AMT>50B'` → `{ yearsFrom:2, yearsTo:10, couponFrom:4,
 * minAmountOutstanding:5e10 }`.
 *
 * §SRCH points at "the shared `parseCriteria(text)` of `core/functions/shared/screen.ts`, restricted
 * to the SRCH factor names". That module does not exist — EQS declares its parser in its own
 * manifest and records that a shared home is still to be created — so this is the SRCH-restricted
 * twin, reusing EQS's `parseScreenNumber` for the number grammar (`50B`, `1.2e10`, `4.5`) rather
 * than writing a second one that would drift. An unreadable term is dropped and reported, never
 * guessed into something adjacent (FUNCTIONS.md §2.4).
 */
export function parseSrchCriteria(text: string): ParsedSrchCriteria {
  const patch: Partial<SrchCriteria> = {};
  const problems: SrchCriteriaProblem[] = [];
  const bad = (term: string, message: string): void => {
    problems.push({ code: 'ARG_PARSE', term, message });
  };

  for (const term of text.split(/\s+/).filter((part) => part !== '')) {
    const match = /^([A-Z_]+)(>=|<=|>|<|=)(.+)$/.exec(term.toUpperCase());
    if (match === null) {
      bad(term, 'not a FACTOR OP VALUE term');
      continue;
    }
    const [, factor = '', op = '', rest = ''] = match;
    const range = /^(.+?)\.\.(.+)$/.exec(rest);
    const low = parseScreenNumber(range === null ? rest : (range[1] ?? ''));
    const high = range === null ? null : parseScreenNumber(range[2] ?? '');
    if (low === null || (range !== null && high === null)) {
      bad(term, `'${rest}' is not a number`);
      continue;
    }
    if (range !== null && op !== '=') {
      bad(term, 'a range needs `=`');
      continue;
    }

    switch (factor) {
      case 'MTY_YEARS':
        if (range !== null) {
          patch.yearsFrom = low;
          patch.yearsTo = high;
        } else if (op === '>' || op === '>=') patch.yearsFrom = low;
        else if (op === '<' || op === '<=') patch.yearsTo = low;
        else {
          patch.yearsFrom = low;
          patch.yearsTo = low;
        }
        break;
      case 'CPN':
        if (range !== null) {
          patch.couponFrom = low;
          patch.couponTo = high;
        } else if (op === '>' || op === '>=') patch.couponFrom = low;
        else if (op === '<' || op === '<=') patch.couponTo = low;
        else {
          patch.couponFrom = low;
          patch.couponTo = low;
        }
        break;
      case 'AMT':
        if (op === '<' || op === '<=') bad(term, 'AMT is a minimum: only > and = apply');
        else patch.minAmountOutstanding = low;
        break;
      default:
        bad(term, `'${factor}' is not a SRCH factor (MTY_YEARS, CPN, AMT)`);
    }
  }
  return { patch, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§SRCH "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type SrchNote =
  | 'NO_BOND_PRICE_SOURCE'
  | 'SEED_UNIVERSE_ONLY'
  | 'TIPS_FRN_NOT_PRICED'
  | 'CURVE_DATE_BEFORE_VALUATION';

export type SrchMaturityBucket = '0-1Y' | '1-3Y' | '3-7Y' | '7-10Y' | '10-20Y' | '20Y+';

export interface SrchUniverse {
  market: 'UST';
  /** `'US Treasuries (govt_terms, as of 2026-09-15)'`. */
  label: string;
  size: number;
  coverage: 'SEED_UNIVERSE_ONLY';
  provIdx: number;
}

export interface SrchFilter {
  field: string;
  /** `'Maturity 2028-09-15 … 2036-09-15'`. */
  label: string;
  /** How many of the universe pass this predicate on its own. */
  matched: number;
  unavailableReason: string | null;
}

export interface SrchPricing {
  basis: 'curve_derived_no_market_quotes';
  curveId: 'UST_PAR' | 'UST_CMT';
  /** `null` when nothing is stored on or before the valuation date. */
  curveDate: string | null;
  interpolation: string | null;
  buildId: number | null;
  settlement: string;
  settlementRule: 'T+1 SIFMA' | 'user';
  provIdx: number;
  engine: { name: string; version: string; inputsHash: string } | null;
}

export interface SrchColumn {
  id: SrchColumnId;
  label: string;
  fmt: SrchColumnFmt;
  decimals?: number;
  sortable: true;
  fieldId?: FieldId;
}

export interface SrchRow {
  instrumentId: number;
  /** `'T 4.25 08/15/36 Govt'`. */
  key: string;
  name: string;
  cusip: string;
  securityType: SrchSecurityType;
  termLabel: string | null;
  onTheRun: boolean;
  maturityDate: string;
  issueDate: string | null;
  couponRate: number | null;
  couponFreq: number;
  dayCount: string;
  isCallable: boolean;
  amountOutstanding: number | null;
  termsProvIdx: number;
  cells: Record<string, ValueCell>;
  /** `q:<instrumentId>` — carried for `Ctrl+W`; no SRCH cell is live. */
  subject: string;
  /** 1-based position in the full sorted result, not in the page. */
  rank: number;
}

export interface SrchCounts {
  universe: number;
  afterFilters: number;
  returned: number;
  excludedNoTerms: number;
  excludedNotPriced: number;
}

export interface SrchFacets {
  securityType: { value: string; count: number }[];
  maturityBucket: { value: SrchMaturityBucket; count: number }[];
  onTheRun: { value: 'true' | 'false'; count: number }[];
}

export interface SrchPayload {
  variant: 'default';
  universe: SrchUniverse;
  filters: SrchFilter[];
  pricing: SrchPricing;
  columns: SrchColumn[];
  rows: SrchRow[];
  counts: SrchCounts;
  facets: SrchFacets;
  savedSearch: { searchId: number; name: string } | null;
  notes: SrchNote[];
}

/** The badge text behind `NO_BOND_PRICE_SOURCE` (§SRCH "Unavailable"). */
export const SRCH_NO_PRICE_SOURCE_DETAIL =
  'yields and prices are derived from the Treasury curve; there is no evaluated bond price ' +
  'source in v1 (BRIEF §1, DATA-04)';

/** The badge text behind `SEED_UNIVERSE_ONLY`. */
export const SRCH_SEED_UNIVERSE_DETAIL =
  'universe = the seeded Treasury securities (bills from the Treasury bill file plus the curated ' +
  'on-the-run notes and bonds); there is no full Treasury issuance file source in this build';

/** Why a TIPS or FRN row carries terms and no analytics — the same boundary YAS draws. */
export const SRCH_TIPS_FRN_DETAIL =
  'TIPS/FRN pricing needs an inflation/reference-rate engine (same boundary as YAS)';

/** The maturity facet's buckets, in payload order, as `[label, upper bound in years]`. */
export const SRCH_MATURITY_BUCKETS: readonly [SrchMaturityBucket, number][] = Object.freeze([
  ['0-1Y', 1],
  ['1-3Y', 3],
  ['3-7Y', 7],
  ['7-10Y', 10],
  ['10-20Y', 20],
  ['20Y+', Number.POSITIVE_INFINITY],
]);

export function srchMaturityBucket(years: number): SrchMaturityBucket {
  for (const [label, upper] of SRCH_MATURITY_BUCKETS) {
    if (years <= upper) return label;
  }
  return '20Y+';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§SRCH "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The whole column whitelist as dictionary ids, so a firm without `treasury.yieldcurve` is told
 * once rather than once per column (ENTL-05).
 *
 * Three columns of the whitelist have no dictionary entry in the landed dictionary and are absent
 * here (see {@link SrchColumnDef.fieldId}); `CURVE_PAR` is added because the derived columns rest
 * on the curve quote and that is the field the licence is written against.
 */
export const SRCH_FIELD_IDS: readonly FieldId[] = Object.freeze([
  ...new Set<FieldId>([
    ...SRCH_COLUMN_IDS.flatMap((id) => {
      const fieldId = SRCH_COLUMNS[id].fieldId;
      return fieldId === undefined ? [] : [fieldId];
    }),
    'CURVE_PAR',
  ]),
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§SRCH "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The fixed prefix every SRCH export carries, whatever the chosen columns are. */
const SRCH_CSV_PREFIX: CsvColumn[] = [
  { id: 'rank', label: 'Rank', type: 'number', decimals: 0 },
  { id: 'key', label: 'Security', type: 'string' },
  { id: 'cusip', label: 'CUSIP', type: 'string' },
  { id: 'securityType', label: 'Type', type: 'string' },
  { id: 'termLabel', label: 'Term', type: 'string' },
  { id: 'maturityDate', label: 'Maturity', type: 'date' },
  { id: 'issueDate', label: 'Issued', type: 'date' },
  { id: 'couponRate', label: 'Coupon', type: 'number', decimals: 3 },
  { id: 'couponFreq', label: 'Freq', type: 'number', decimals: 0 },
  { id: 'dayCount', label: 'Day count', type: 'string' },
  { id: 'onTheRun', label: 'On-the-run', type: 'boolean' },
  { id: 'isCallable', label: 'Callable', type: 'boolean' },
  { id: 'amountOutstanding', label: 'Amt outstanding', type: 'number', decimals: 0 },
];

/**
 * Column ids the prefix already reports, under the prefix's own spelling.
 *
 * §SRCH says the export is "the fixed prefix … followed by one column per `payload.columns[]` entry
 * **that is not already in the prefix**". The two lists spell the same datum differently (`CPN` vs
 * `couponRate`), so "already in the prefix" is decided by this map rather than by string equality —
 * otherwise every default export would carry the coupon, the maturity and the CUSIP twice.
 */
const SRCH_CSV_PREFIX_ALIAS: Readonly<Partial<Record<SrchColumnId, string>>> = Object.freeze({
  CUSIP: 'cusip',
  SECURITY_TYP: 'securityType',
  TERM_LABEL: 'termLabel',
  CPN: 'couponRate',
  CPN_FREQ: 'couponFreq',
  MATURITY: 'maturityDate',
  ISSUE_DT: 'issueDate',
  DAY_CNT_DES: 'dayCount',
  ON_THE_RUN: 'onTheRun',
  AMT_OUTSTANDING: 'amountOutstanding',
});

const SRCH_CSV_SUFFIX: CsvColumn[] = [
  { id: 'curveId', label: 'Curve', type: 'string' },
  { id: 'curveDate', label: 'Curve date', type: 'date' },
  { id: 'settlement', label: 'Settlement', type: 'date' },
  { id: 'pricingBasis', label: 'Pricing basis', type: 'string' },
  { id: 'source', label: 'Source', type: 'string' },
];

/** A payload column's CSV type, from its display format. */
function csvTypeOf(fmt: SrchColumnFmt): CsvColumn['type'] {
  if (fmt === 'date') return 'date';
  if (fmt === 'text') return 'string';
  return 'number';
}

export function srchCsvColumns(_params: SrchParams, payload: SrchPayload): CsvColumn[] {
  const extra: CsvColumn[] = [];
  for (const column of payload.columns) {
    if (SRCH_CSV_PREFIX_ALIAS[column.id] !== undefined) continue;
    extra.push({
      id: column.id,
      label: column.label,
      type: csvTypeOf(column.fmt),
      ...(column.decimals === undefined ? {} : { decimals: column.decimals }),
    });
  }
  return [...SRCH_CSV_PREFIX, ...extra, ...SRCH_CSV_SUFFIX];
}

type CsvValue = string | number | boolean | null;

export function srchCsvRows(payload: SrchPayload): CsvValue[][] {
  const extra = payload.columns.filter(
    (column) => SRCH_CSV_PREFIX_ALIAS[column.id] === undefined,
  );
  return payload.rows.map((row) => {
    const cells: CsvValue[] = extra.map((column) => {
      const cell = row.cells[column.id];
      if (cell === undefined) return null;
      // §1.6 rule 2: an absent value is an empty field, never a zero.
      return typeof cell.v === 'boolean' ? cell.v : (cell.v ?? null);
    });
    return [
      row.rank,
      row.key,
      row.cusip,
      row.securityType,
      row.termLabel,
      row.maturityDate,
      row.issueDate,
      row.couponRate,
      row.couponFreq,
      row.dayCount,
      row.onTheRun,
      row.isCallable,
      row.amountOutstanding,
      ...cells,
      payload.pricing.curveId,
      payload.pricing.curveDate,
      payload.pricing.settlement,
      payload.pricing.basis,
      'treasury.yieldcurve',
    ];
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SRCH = defineFunction<typeof SrchParams, SrchPayload>({
  code: 'SRCH',
  name: 'Treasury Search',
  aliases: ['BSRCH'],
  tier: 3,
  category: 'screening',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: SrchParams,
  paramGrammar: {
    positional: [{ name: 'securityTypes', type: 'string', optional: true }],
    keyed: {
      MAT: { name: 'maturityFrom', type: 'date' },
      MATTO: { name: 'maturityTo', type: 'date' },
      YRS: { name: 'yearsFrom', type: 'number' },
      YRSTO: { name: 'yearsTo', type: 'number' },
      CPN: { name: 'couponFrom', type: 'number' },
      CPNTO: { name: 'couponTo', type: 'number' },
      OTR: { name: 'onTheRun', type: 'enum', values: ['any', 'only', 'exclude'] },
      CALL: { name: 'callable', type: 'enum', values: ['any', 'only', 'exclude'] },
      AMT: { name: 'minAmountOutstanding', type: 'number' },
      CUSIP: { name: 'cusip', type: 'string' },
      CRV: { name: 'curveId', type: 'curve', values: ['UST_PAR', 'UST_CMT'] },
      CRVD: { name: 'curveDate', type: 'date' },
      S: { name: 'settlement', type: 'date' },
      COLS: { name: 'columns', type: 'string' },
      SORT: { name: 'sort', type: 'string' },
      N: { name: 'pageSize', type: 'int' },
      SAVED: { name: 'savedSearchId', type: 'int' },
    },
    rest: { name: 'criteria', type: 'text' },
  },
  fieldIds: (): FieldId[] => [...SRCH_FIELD_IDS],
  pageable: true,
  // There is no Treasury security quote source in this build (`md_lines` carries no `govt` line),
  // so no cell can update and the screen registers no subjects. `rows[].subject` exists only so
  // `Ctrl+W` can push the selection into a watchlist, where W subscribes it and gets the same
  // honest `pending` state (§SRCH "Live").
  live: null,
  csv: {
    filename: (params, ctx): string =>
      `SRCH_${params.market}_${ctx.asOf.replace(/[-:]/g, '')}.csv`,
    columns: srchCsvColumns,
    rows: (payload): CsvValue[][] => srchCsvRows(payload),
  },
  help: {
    summary: 'Search Treasuries by type, maturity, coupon and benchmark status',
    description:
      'SRCH screens the Treasury universe by terms and conditions — security type, maturity ' +
      'window, coupon range, on-the-run status, callability, amount outstanding and CUSIP — and ' +
      'shows the matching securities with yields, prices, accrued and duration derived from the ' +
      'Treasury curve for the selected settlement date. There is no evaluated fixed-income ' +
      'pricing source in this build, so the analytic columns are curve-derived rather than market ' +
      'quotes and are labelled NO_BOND_PRICE_SOURCE; they use exactly the engines YAS uses, so a ' +
      'row equals the YAS screen for the same security and settlement. The universe is the seeded ' +
      'Treasury set (bills from the Treasury bill file and the on-the-run notes and bonds); ' +
      'corporates, munis and mortgages are out of scope in v1. Press Enter on a row for YAS, ' +
      'Ctrl+S to save the search.',
    params: [
      { name: 'securityTypes', text: 'bill, note, bond, tips, frn', example: 'NOTE,BOND' },
      { name: 'maturityFrom', text: 'maturity window start', example: '2028-01-01' },
      { name: 'maturityTo', text: 'maturity window end', example: '2036-12-31' },
      { name: 'yearsFrom', text: 'years to maturity, from', example: '2' },
      { name: 'yearsTo', text: 'years to maturity, to', example: '10' },
      { name: 'couponFrom', text: 'coupon range in percent, from', example: '4' },
      { name: 'couponTo', text: 'coupon range in percent, to', example: '5' },
      { name: 'couponTypes', text: 'fixed, zero, float, step, inflation_linked' },
      { name: 'onTheRun', text: 'any, only or exclude benchmarks' },
      { name: 'callable', text: 'any, only or exclude callables' },
      { name: 'minAmountOutstanding', text: 'minimum amount outstanding', example: '50B' },
      { name: 'cusip', text: 'CUSIP or prefix', example: '912797' },
      { name: 'columns', text: 'columns to show', example: 'CUSIP,MATURITY,YLD_YTM_MID' },
      { name: 'sort', text: 'column:direction', example: 'YLD_YTM_MID:desc' },
      { name: 'pageSize', text: 'rows per page', example: '100' },
      { name: 'settlement', text: 'settlement date; default T+1 SIFMA' },
      { name: 'curveId', text: 'UST_PAR or UST_CMT' },
      { name: 'curveDate', text: 'curve date; default latest' },
      { name: 'savedSearchId', text: 'load a saved search' },
    ],
    keys: [
      { key: 'Enter', action: 'price the selected security in YAS' },
      { key: 'T', action: 'cycle the security-type presets' },
      { key: 'O', action: 'cycle on-the-run any / only / exclude' },
      { key: 'C', action: 'switch the curve' },
      { key: 'Ctrl+S', action: 'save the search' },
    ],
    sources: [
      'treasury.bills',
      'treasury.yieldcurve',
      'fed.h15',
      'internal.user',
      'internal.derived',
    ],
    related: ['YAS', 'DES', 'CRVF', 'GC', 'BTMM'],
  },
  keymap: [
    { key: 'Enter', action: 'run-search', when: 'form', description: 'Run the criteria form' },
    { key: 'Enter', action: 'open-yas', when: 'grid', description: 'Price the security (YAS)' },
    {
      key: 'Shift+Enter',
      action: 'open-yas-next',
      when: 'grid',
      description: 'YAS in the next panel',
    },
    { key: 'D', action: 'open-des', when: 'grid', description: 'Instrument record (DES)' },
    { key: 'G', action: 'open-gp', when: 'grid', description: 'Price history (GP)' },
    { key: 'T', action: 'cycle-types', description: 'Cycle the security-type presets' },
    { key: 'O', action: 'cycle-otr', description: 'Cycle on-the-run any / only / exclude' },
    { key: 'M', action: 'maturity-prompt', description: 'Prompt for the maturity window' },
    { key: 'C', action: 'cycle-curve', description: 'Switch UST_PAR / UST_CMT' },
    { key: 'S', action: 'settlement-prompt', description: 'Prompt for the settlement date' },
    { key: 'X', action: 'clear-criteria', description: 'Reset every criterion' },
    { key: ',', action: 'sort-prev-col', when: 'grid', description: 'Sort by the previous column' },
    { key: '.', action: 'sort-next-col', when: 'grid', description: 'Sort by the next column' },
    { key: 'PageDown', action: 'page-fwd', when: 'grid', description: 'Next page' },
    { key: 'PageUp', action: 'page-back', when: 'grid', description: 'Previous page' },
    { key: 'Ctrl+S', action: 'save-search', description: 'Save the search' },
    { key: 'Ctrl+W', action: 'add-watchlist', when: 'grid', description: 'Add to a watchlist' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default SRCH;
