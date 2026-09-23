// packages/core/src/functions/manifests/EQS.ts
//
// `EQS` — Equity Screening (FUNCTIONS_TIER2.md §EQS L273-461, FUNCTIONS.md §6 L1092).
//
// EQS is the one Tier 2 screen that takes no security: a universe, up to eight criteria, a column
// set and a sort. Its params double as the persisted shape of `saved_searches.query` when
// `kind = 'eqs'` — `ScreenCriteria` below is that shape, and `EqsParams` extends it with the three
// request-only keys (`pageSize`, `knownAt`, `savedSearchId`) that must never be saved.
//
// ## Where `ScreenCriteria` lives
//
// §EQS names `packages/core/src/functions/shared/screen.ts` as its home, shared with the
// `/saved-searches` route. That file is not in this work package's file list, so the declarations
// live here and the route imports them from this manifest. Nothing about the shape changes; when
// `shared/screen.ts` is created it should re-export these rather than restate them, because a
// second copy of a persisted schema is a migration waiting to happen.
//
// ## Two factors the dictionary does not (yet) define
//
// `EqsFactor` is the whitelist §EQS fixes, and nine of its members — `RET_3M`, `PUBLIC_FLOAT`,
// `SHORT_INT_RATIO`, `GROSS_PROFIT`, `FREE_CASH_FLOW`, `RETURN_COM_EQY`, `PE_RATIO`,
// `EV_TO_EBITDA`, `TOTAL_EQUITY` — have no `core/fields/dictionary.ts` entry in this build.
// `monitorColumn` throws on an unknown id (correctly: a monitor naming a field the dictionary does
// not have is a manifest bug), so {@link eqsColumn} falls back to the local {@link FACTOR_META}
// table for those nine. That table carries a **label and a render hint**, never a value: the
// number still comes from the resolver's own reads or it is absent with a reason. When the
// dictionary gains those ids the fallback stops being reached and can be deleted.

import { z } from 'zod';

import type { MonitorColumn, MonitorRow } from '../shared/monitor.js';
import { monitorColumn } from '../shared/monitor.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { monitorPrecheckFields } from './QM.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { getField } from '../../fields/dictionary.js';
import type { FieldFormat } from '../../fields/format.js';
import { SortSpec } from '../schemas.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§EQS "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const EqsFactor = z.enum([
  // quote / bars (source class 'quote' | 'bars')
  'PX_LAST', 'CHG_PCT_1D', 'PX_VOLUME', 'VOLUME_AVG_30D', 'PX_HIGH_52W', 'PX_LOW_52W',
  'RET_1D', 'RET_1W', 'RET_1M', 'RET_3M', 'RET_YTD', 'RET_1Y', 'VOL_30D', 'BETA_1Y',
  // reference / corporate actions (source class 'reference' | 'actions')
  'CUR_MKT_CAP', 'EQY_SH_OUT', 'PUBLIC_FLOAT', 'EQY_FLOAT_PCT', 'SHORT_INT_RATIO',
  'IDX_MEMBER_WEIGHT', 'DVD_YIELD',
  // fundamentals from fin_statements (source class 'statements')
  'SALES_REV_TURN', 'GROSS_PROFIT', 'IS_OPER_INC', 'NET_INCOME', 'IS_EPS_DIL', 'FREE_CASH_FLOW',
  'NET_MARGIN', 'SALES_GROWTH_YOY', 'RETURN_COM_EQY', 'PE_RATIO', 'PX_TO_BOOK_RATIO',
  'PX_TO_SALES_RATIO', 'EV_TO_EBITDA',
  // fundamentals from the xbrl_frames cross-section (source class 'frames')
  'BS_TOT_ASSET', 'BS_TOT_LIAB2', 'TOTAL_EQUITY', 'CF_CASH_FROM_OPER',
]);
export type EqsFactor = z.infer<typeof EqsFactor>;

export const EqsOp = z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'between', 'top', 'bottom']);
export type EqsOp = z.infer<typeof EqsOp>;

export const EqsCriterion = z.object({
  factor: EqsFactor,
  /** gt/gte/lt/lte/eq/ne: the threshold; between: the lower bound; top/bottom: the count n. */
  value: z.number().nullable().default(null),
  /** between: the upper bound; null otherwise. */
  value2: z.number().nullable().default(null),
  op: EqsOp,
});
export type EqsCriterion = z.infer<typeof EqsCriterion>;

export const EQS_DEFAULT_COLUMNS: readonly EqsFactor[] = Object.freeze([
  'CUR_MKT_CAP',
  'PX_LAST',
  'CHG_PCT_1D',
  'RET_1Y',
  'BS_TOT_ASSET',
] as EqsFactor[]);

/** The persisted shape of `saved_searches.query` when `kind = 'eqs'` (DATA_MODEL §14). */
export const ScreenCriteria = z.object({
  universe: z.enum(['INDEX', 'EQUITY', 'ETF', 'WATCHLIST']).default('INDEX'),
  index: z.string().max(12).default('SPX'),
  watchlistId: z.number().int().nullable().default(null),
  /** GICS level-1 sector name, e.g. `'Information Technology'`. */
  sector: z.string().max(64).nullable().default(null),
  /** `instruments.exch_code` / `listings.mic`. */
  exchange: z.string().max(4).nullable().default(null),
  /** `issues.country_of_issue`. */
  country: z.string().length(2).nullable().default(null),
  criteria: z.array(EqsCriterion).max(8).default([]),
  columns: z.array(EqsFactor).min(1).max(12).default([...EQS_DEFAULT_COLUMNS]),
  sort: SortSpec.default({ col: 'CUR_MKT_CAP', dir: 'desc' }),
});
export type ScreenCriteria = z.infer<typeof ScreenCriteria>;

export const EqsParams = ScreenCriteria.extend({
  pageSize: z.number().int().min(20).max(200).default(50),
  /** PIT override for the fundamental factors (STOR-06); undefined = `ctx.asOf.knownAt`. */
  knownAt: z.iso.datetime().optional(),
  /** Load `saved_searches.query` and merge it UNDER the explicit params. */
  savedSearchId: z.number().int().optional(),
});
export type EqsParams = z.infer<typeof EqsParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Factor metadata (§EQS steps 4-5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type EqsFactorSource = 'quote' | 'bars' | 'reference' | 'actions' | 'statements' | 'frames';

/** Which read a factor comes out of — the resolver batches one query per distinct value. */
export const EQS_FACTOR_SOURCE: Readonly<Record<EqsFactor, EqsFactorSource>> = Object.freeze({
  PX_LAST: 'quote',
  CHG_PCT_1D: 'quote',
  PX_VOLUME: 'quote',

  VOLUME_AVG_30D: 'bars',
  PX_HIGH_52W: 'bars',
  PX_LOW_52W: 'bars',
  RET_1D: 'bars',
  RET_1W: 'bars',
  RET_1M: 'bars',
  RET_3M: 'bars',
  RET_YTD: 'bars',
  RET_1Y: 'bars',
  VOL_30D: 'bars',
  BETA_1Y: 'bars',

  CUR_MKT_CAP: 'reference',
  EQY_SH_OUT: 'reference',
  PUBLIC_FLOAT: 'reference',
  EQY_FLOAT_PCT: 'reference',
  SHORT_INT_RATIO: 'reference',
  IDX_MEMBER_WEIGHT: 'reference',
  DVD_YIELD: 'actions',

  SALES_REV_TURN: 'statements',
  GROSS_PROFIT: 'statements',
  IS_OPER_INC: 'statements',
  NET_INCOME: 'statements',
  IS_EPS_DIL: 'statements',
  FREE_CASH_FLOW: 'statements',
  NET_MARGIN: 'statements',
  SALES_GROWTH_YOY: 'statements',
  RETURN_COM_EQY: 'statements',
  PE_RATIO: 'statements',
  PX_TO_BOOK_RATIO: 'statements',
  PX_TO_SALES_RATIO: 'statements',
  EV_TO_EBITDA: 'statements',

  BS_TOT_ASSET: 'frames',
  BS_TOT_LIAB2: 'frames',
  TOTAL_EQUITY: 'frames',
  CF_CASH_FROM_OPER: 'frames',
});

/** `taxonomy:concept/unit` and the frame family (instant or duration) per `frames` factor. */
export interface EqsFrameConcept {
  concept: string;
  unit: string;
  /** `'I'` → the frame id ends in `I` (`CY2024Q4I`); `'D'` → a duration frame (`CY2024Q4`). */
  kind: 'instant' | 'duration';
}

export const EQS_FRAME_CONCEPT: Readonly<Record<string, EqsFrameConcept>> = Object.freeze({
  BS_TOT_ASSET: { concept: 'us-gaap:Assets', unit: 'USD', kind: 'instant' },
  BS_TOT_LIAB2: { concept: 'us-gaap:Liabilities', unit: 'USD', kind: 'instant' },
  TOTAL_EQUITY: { concept: 'us-gaap:StockholdersEquity', unit: 'USD', kind: 'instant' },
  CF_CASH_FROM_OPER: {
    concept: 'us-gaap:NetCashProvidedByUsedInOperatingActivities',
    unit: 'USD',
    kind: 'duration',
  },
});

/**
 * Label and render hint for the nine factors the dictionary has no entry for (see the file
 * header). Never a value — only how to title the column and how many decimals to show.
 */
const FACTOR_META: Readonly<
  Record<string, { label: string; fmt: FieldFormat; decimals?: number }>
> = Object.freeze({
  RET_3M: { label: '3-month return', fmt: 'pct', decimals: 2 },
  PUBLIC_FLOAT: { label: 'Public float', fmt: 'ccy', decimals: 0 },
  SHORT_INT_RATIO: { label: 'Days to cover', fmt: 'px', decimals: 2 },
  GROSS_PROFIT: { label: 'Gross profit', fmt: 'ccy', decimals: 0 },
  FREE_CASH_FLOW: { label: 'Free cash flow', fmt: 'ccy', decimals: 0 },
  RETURN_COM_EQY: { label: 'Return on equity', fmt: 'pct', decimals: 2 },
  PE_RATIO: { label: 'Price / earnings', fmt: 'px', decimals: 2 },
  EV_TO_EBITDA: { label: 'EV / EBITDA', fmt: 'px', decimals: 2 },
  TOTAL_EQUITY: { label: 'Total equity', fmt: 'ccy', decimals: 0 },
});

/** The dictionary's column when it has the field, the local fallback when it does not. */
export function eqsColumn(factor: EqsFactor): MonitorColumn {
  if (getField(factor) !== undefined) return monitorColumn(factor);
  const meta = FACTOR_META[factor];
  if (meta === undefined) {
    throw new TypeError(
      `EQS: '${factor}' is neither a dictionary field nor a declared fallback column`,
    );
  }
  const column: MonitorColumn = { id: factor, label: meta.label, fmt: meta.fmt };
  return meta.decimals === undefined ? column : { ...column, decimals: meta.decimals };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The criteria mini-language (§EQS "Argument grammar")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One term the parser could not read; the command line turns it into a `CommandProblem`. */
export interface EqsCriteriaProblem {
  code: 'ARG_PARSE';
  term: string;
  message: string;
}

export interface ParsedCriteria {
  criteria: EqsCriterion[];
  problems: EqsCriteriaProblem[];
}

const SUFFIX: Readonly<Record<string, number>> = Object.freeze({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 });

/** `'5e10'`, `'12.5'`, `'25%'` (→ 0.25), `'1.2B'`, `'350M'`, `'40K'`. `null` when unreadable. */
export function parseScreenNumber(text: string): number | null {
  const raw = text.trim();
  if (raw === '') return null;
  if (raw.endsWith('%')) {
    const n = Number(raw.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const last = raw.slice(-1).toUpperCase();
  const factor = SUFFIX[last];
  if (factor !== undefined) {
    const n = Number(raw.slice(0, -1));
    return Number.isFinite(n) ? n * factor : null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const OP_TOKENS: readonly { token: string; op: EqsOp }[] = [
  { token: '>=', op: 'gte' },
  { token: '<=', op: 'lte' },
  { token: '<>', op: 'ne' },
  { token: '>', op: 'gt' },
  { token: '<', op: 'lt' },
  { token: '=', op: 'eq' },
];

function isFactor(name: string): name is EqsFactor {
  return (EqsFactor.options as readonly string[]).includes(name);
}

/**
 * `'BS_TOT_ASSET>5e10 NET_MARGIN>20% PE_RATIO=10..25 RET_1Y#TOP50'` → criteria.
 *
 * An unreadable term is **dropped and reported**, never guessed into something adjacent: a screen
 * that silently reinterprets `NET_MARGIN>2O%` as `>2` returns a plausible-looking wrong answer.
 */
export function parseCriteria(text: string): ParsedCriteria {
  const criteria: EqsCriterion[] = [];
  const problems: EqsCriteriaProblem[] = [];
  const bad = (term: string, message: string): void => {
    problems.push({ code: 'ARG_PARSE', term, message });
  };

  for (const term of text.split(/\s+/).filter((t) => t !== '')) {
    const hash = term.indexOf('#');
    if (hash > 0) {
      const factor = term.slice(0, hash).toUpperCase();
      const rank = term.slice(hash + 1).toUpperCase();
      const match = /^(TOP|BOT)(\d+)$/.exec(rank);
      if (!isFactor(factor) || match === null) {
        bad(term, `expected FACTOR#TOPn or FACTOR#BOTn`);
        continue;
      }
      criteria.push({
        factor,
        op: match[1] === 'TOP' ? 'top' : 'bottom',
        value: Number(match[2]),
        value2: null,
      });
      continue;
    }

    const found = OP_TOKENS.find((o) => term.includes(o.token));
    if (found === undefined) {
      bad(term, 'expected FACTOR<op>VALUE with op one of > >= < <= = <>');
      continue;
    }
    const at = term.indexOf(found.token);
    const factor = term.slice(0, at).toUpperCase();
    const rhs = term.slice(at + found.token.length);
    if (!isFactor(factor)) {
      bad(term, `'${factor}' is not a screening factor`);
      continue;
    }
    if (found.op === 'eq' && rhs.includes('..')) {
      const [lo, hi] = rhs.split('..');
      const low = parseScreenNumber(lo ?? '');
      const high = parseScreenNumber(hi ?? '');
      if (low === null || high === null) {
        bad(term, 'expected FACTOR=LOW..HIGH');
        continue;
      }
      criteria.push({ factor, op: 'between', value: low, value2: high });
      continue;
    }
    const value = parseScreenNumber(rhs);
    if (value === null) {
      bad(term, `'${rhs}' is not a number`);
      continue;
    }
    criteria.push({ factor, op: found.op, value, value2: null });
  }
  return { criteria, problems };
}

const OP_TEXT: Readonly<Record<EqsOp, string>> = Object.freeze({
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  ne: '<>',
  between: '=',
  top: '#TOP',
  bottom: '#BOT',
});

/** The inverse of {@link parseCriteria} for one criterion — the `# screen:` CSV header uses it. */
export function formatCriterion(c: EqsCriterion): string {
  if (c.op === 'top' || c.op === 'bottom') return `${c.factor}${OP_TEXT[c.op]}${String(c.value ?? 0)}`;
  if (c.op === 'between') return `${c.factor}=${String(c.value ?? 0)}..${String(c.value2 ?? 0)}`;
  return `${c.factor}${OP_TEXT[c.op]}${String(c.value ?? 0)}`;
}

export function formatCriteria(criteria: readonly EqsCriterion[]): string {
  return criteria.map(formatCriterion).join(' ');
}

/** `'Total assets > 50000000000'` — the label the criteria form and the payload both show. */
export function criterionLabel(c: EqsCriterion): string {
  const label = eqsColumn(c.factor).label;
  switch (c.op) {
    case 'between':
      return `${label} between ${String(c.value)} and ${String(c.value2)}`;
    case 'top':
      return `${label} top ${String(c.value)}`;
    case 'bottom':
      return `${label} bottom ${String(c.value)}`;
    default:
      return `${label} ${OP_TEXT[c.op]} ${String(c.value)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§EQS "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EqsUniverse {
  kind: 'INDEX' | 'EQUITY' | 'ETF' | 'WATCHLIST';
  /** `'SPX Index members (2026-09-14)'`. */
  label: string;
  indexInstrumentId: number | null;
  watchlistId: number | null;
  asOfDate: string | null;
  size: number;
  provIdx: number;
}

export interface EqsCriterionView {
  factor: EqsFactor;
  op: EqsOp;
  value: number | null;
  value2: number | null;
  label: string;
  source: EqsFactorSource;
  passed: number;
  noData: number;
  /** Set when the factor has no reachable source; the criterion is then NOT applied. */
  unavailableReason: string | null;
}

export type EqsRow = MonitorRow & {
  rank: number;
  gicsSubIndustry: string | null;
  issuerId: number | null;
  cik: string | null;
};

export interface EqsPayload {
  variant: 'default';
  universe: EqsUniverse;
  filters: { sector: string | null; exchange: string | null; country: string | null };
  /** Evaluation order = array order. */
  criteria: EqsCriterionView[];
  columns: MonitorColumn[];
  rows: EqsRow[];
  counts: {
    universe: number;
    afterFilters: number;
    afterCriteria: number;
    returned: number;
    excludedNoData: number;
  };
  knownAt: string;
  /** `'CY2024Q4I'` — the `xbrl_frames` period the `frames` factors were read at. */
  frame: string | null;
  savedSearch: { searchId: number; name: string } | null;
  notes: string[];
}

/** The cell an absent value gets: `null`, stated, and citing nothing (§EQS payload note). */
export const EQS_ABSENT_CELL: Readonly<ValueCell> = Object.freeze({
  v: null,
  st: 'na',
  provIdx: -1,
} as ValueCell);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§EQS "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const EQS_CSV_PREFIX: readonly CsvColumn[] = Object.freeze([
  { id: 'rank', label: 'Rank', type: 'number' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'name', label: 'Name', type: 'string' },
  { id: 'assetClass', label: 'Asset class', type: 'string' },
  { id: 'exchange', label: 'Exchange', type: 'string' },
  { id: 'gicsSector', label: 'GICS sector', type: 'string' },
  { id: 'gicsSubIndustry', label: 'GICS sub-industry', type: 'string' },
  { id: 'cik', label: 'CIK', type: 'string' },
] as CsvColumn[]);

export function eqsCsvColumns(_params: EqsParams, payload: EqsPayload): CsvColumn[] {
  return [
    ...EQS_CSV_PREFIX,
    ...payload.columns.map((c): CsvColumn => {
      const column: CsvColumn = { id: c.id, label: c.label, type: 'number' };
      return c.decimals === undefined ? column : { ...column, decimals: c.decimals };
    }),
  ];
}

export function eqsCsvRows(payload: EqsPayload): (string | number | boolean | null)[][] {
  return payload.rows.map((row) => [
    row.rank,
    row.key,
    row.name,
    row.assetClass,
    row.exchCode,
    row.gicsSector,
    row.gicsSubIndustry,
    row.cik,
    ...payload.columns.map((c) => {
      const cell = row.cells[c.id];
      const v = cell?.v ?? null;
      return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : null;
    }),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§EQS "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const LIVE_FACTORS: readonly string[] = ['PX_LAST', 'CHG_PCT_1D', 'PX_VOLUME'];

function eqsLive(_params: EqsParams, payload: EqsPayload): LiveSpec | null {
  if (!payload.columns.some((c) => LIVE_FACTORS.includes(c.id))) return null;
  if (payload.rows.length === 0) return null;
  return {
    subjects: payload.rows.map((r) => r.subject),
    fields: [...LIVE_FACTORS] as FieldId[],
    conflationMs: 1000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

function asOfCompact(asOf: string): string {
  return asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export const EQS = defineFunction<typeof EqsParams, EqsPayload>({
  code: 'EQS',
  name: 'Equity Screening',
  aliases: ['SCREEN'],
  tier: 2,
  category: 'screening',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: EqsParams,
  paramGrammar: {
    positional: [
      {
        name: 'universe',
        type: 'enum',
        values: ['INDEX', 'EQUITY', 'ETF', 'WATCHLIST'],
        optional: true,
      },
    ],
    keyed: {
      IDX: { name: 'index', type: 'index' },
      WL: { name: 'watchlistId', type: 'watchlist' },
      SEC: { name: 'sector', type: 'string' },
      EXCH: { name: 'exchange', type: 'string' },
      CTRY: { name: 'country', type: 'currency' },
      SORT: { name: 'sort', type: 'string' },
      COLS: { name: 'columns', type: 'string' },
      N: { name: 'pageSize', type: 'int' },
      KNOWN: { name: 'knownAt', type: 'datetime' },
      SAVED: { name: 'savedSearchId', type: 'int' },
    },
    rest: { name: 'criteria', type: 'text' },
  },
  /**
   * §EQS names the whole `EqsFactor` whitelist as the pre-check set. `monitorPrecheckFields`
   * narrows it to the ids the entitlement evaluator can actually decide for a manifest that names
   * no asset class: a field with no `field_licence` row, or with per-class rows that disagree on
   * the source, is `FIELD_UNKNOWN` (deny) — a denial about nothing, which would put noise in every
   * screen's `meta.entitlement` and tell a user their contract is short when it is not. Reference
   * columns are master columns and are not part of a source decision either (the reasoning QM
   * records at length). The narrowing costs the `sec.frames` / `sec.companyfacts` pre-check that
   * §EQS wants once per run; the resolver still reports those gaps per factor through
   * `ctx.unavailable`.
   */
  fieldIds: (): FieldId[] => monitorPrecheckFields(EqsFactor.options),
  pageable: true,
  live: eqsLive,
  csv: {
    filename: (params, ctx): string =>
      `EQS_${params.universe === 'INDEX' ? params.index : params.universe}_` +
      `${asOfCompact(ctx.asOf)}.csv`,
    columns: eqsCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => eqsCsvRows(payload),
  },
  help: {
    summary: 'Multi-factor equity screens over the index, listed or watchlist universe',
    description:
      'EQS screens a universe by any combination of up to eight factors. Choose the universe ' +
      "(an index's members, all US listed equities or ETFs, or a watchlist), add criteria as " +
      'FACTOR>VALUE terms on the command line or in the criteria form, pick the columns you want ' +
      'and sort on any of them. Price and volume factors come from the exchange quote and the ' +
      'daily bars; balance-sheet factors come from the SEC XBRL frames cross-section; ' +
      'income-statement factors and the valuation multiples come from standardised SEC filings ' +
      'and are therefore only available for issuers whose filings have already been ingested — ' +
      'press F on a name in FA to ingest it. A security whose value for a criterion is missing is ' +
      'excluded from the result and counted under "no data": EQS never guesses a number to keep a ' +
      'row in. Press Ctrl+S to save a screen and reuse it, V on a row for its peer comparison, ' +
      'Enter for the security description.',
    params: [
      { name: 'universe', text: 'INDEX, EQUITY, ETF or WATCHLIST', example: 'EQS EQUITY' },
      { name: 'index', text: 'index code when universe is INDEX', example: 'IDX=SPX' },
      { name: 'watchlistId', text: 'watchlist when universe is WATCHLIST', example: 'WL=Core' },
      { name: 'sector', text: 'GICS sector name', example: 'SEC=Energy' },
      { name: 'exchange', text: 'composite exchange code', example: 'EXCH=US' },
      { name: 'country', text: 'ISO country of issue', example: 'CTRY=US' },
      {
        name: 'criteria',
        text: 'FACTOR>VALUE terms, A..B for a range, #TOP50 for a rank cut',
        example: 'RET_1Y#TOP50',
      },
      { name: 'columns', text: 'factor ids to show', example: 'COLS=PE_RATIO,RET_1Y' },
      { name: 'sort', text: 'column and direction', example: 'SORT=RET_1Y:desc' },
      { name: 'pageSize', text: '20–200 rows per page', example: 'N=100' },
      {
        name: 'knownAt',
        text: 'point-in-time date for the fundamental factors',
        example: 'KNOWN=2026-06-01',
      },
      { name: 'savedSearchId', text: 'load a saved screen', example: 'SAVED=3' },
    ],
    keys: [
      { key: 'C', action: 'edit the criteria form' },
      { key: 'A', action: 'add a criterion' },
      { key: 'U', action: 'cycle the universe' },
      { key: 'X', action: 'set the index code' },
      { key: 'F', action: 'add a column' },
      { key: 'S', action: 'sort by the focused column' },
      { key: 'G', action: 'group by GICS sector' },
      { key: 'Ctrl+S', action: 'save this screen' },
      { key: 'O', action: 'open a saved screen' },
      { key: 'Enter', action: 'DES on the focused row' },
      { key: 'V', action: 'RV on the focused row' },
    ],
    sources: [
      'sec.frames',
      'sec.companyfacts',
      'sec.archives',
      'ssga.holdings',
      'wiki.sp500',
      'cboe.quotes',
      'yahoo.chart',
      'finra.shortInterest',
      'internal.derived',
    ],
    related: ['RV', 'FA', 'SECF', 'MEMB', 'QM', 'W'],
  },
  keymap: [
    { key: 'C', action: 'focus-criteria', description: 'Edit the criteria in place' },
    { key: 'A', action: 'add-criterion', when: 'form', description: 'Append a criterion row' },
    { key: 'Delete', action: 'remove-criterion', when: 'form', description: 'Remove a criterion' },
    { key: 'U', action: 'cycle-universe', description: 'INDEX → EQUITY → ETF → WATCHLIST' },
    { key: 'X', action: 'set-index', description: 'Set the index code' },
    { key: 'F', action: 'add-column', when: 'grid', description: 'Add a factor column' },
    { key: 'Delete', action: 'remove-column', when: 'grid', description: 'Remove the column' },
    { key: 'S', action: 'sort-by-column', when: 'grid', description: 'Sort by this column' },
    { key: 'G', action: 'toggle-group', when: 'grid', description: 'Group by GICS sector' },
    { key: 'Ctrl+S', action: 'save-screen', description: 'Save this screen' },
    { key: 'O', action: 'open-saved', description: 'Open a saved screen' },
    { key: 'Enter', action: 'open-des', when: 'grid', description: 'Description of this name' },
    { key: 'Shift+Enter', action: 'open-des-next', when: 'grid', description: 'DES in the next panel' },
    { key: 'V', action: 'open-rv', when: 'grid', description: 'Relative value against peers' },
    { key: 'Alt+F', action: 'open-fa', when: 'grid', description: 'Financial analysis' },
    { key: 'Ctrl+W', action: 'add-watchlist', when: 'grid', description: 'Add the page to a watchlist' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default EQS;
