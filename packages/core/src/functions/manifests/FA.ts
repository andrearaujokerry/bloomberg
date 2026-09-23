// packages/core/src/functions/manifests/FA.ts
//
// FA — Financial Analysis (FUNCTIONS_TIER2.md §FA L4-158, FUNCTIONS.md §6).
//
// FA is the point-in-time screen: `fin_statements` selected on `filed_at <= knownAt`, one column
// per fiscal period, every column naming the filing it came from. Three properties of this
// manifest carry the design and are worth stating here, because the resolver depends on all three:
//
//  1. **Two variants, one code.** `equity → 'equity'`, `etf → 'fund'` (FUNC-02). An ETF has no
//     income statement, so the fund variant shows sponsor terms, NAV and the latest holdings file
//     instead — and says so through `meta.unavailable` rather than by rendering an empty grid.
//  2. **`rows[].values` is a bare `number[]`, and that is deliberate.** Every column carries its
//     own `provIdx` (the companyfacts capture that produced it), so a cell is cited at BLOCK level
//     — FUNCTIONS.md §1.3 rule 2 and the runner's `assertPayloadMeta` walk, which cannot reach
//     inside a bare array. A row value is never a `ValueCell`: twelve rows × sixteen columns of
//     cells repeating the same citation is the payload the rule exists to avoid.
//  3. **`asReported` is a parallel array, not a second shape.** When `params.asReported` is false
//     every entry is `null`; when true each entry names the XBRL concept, taxonomy, `fact_id` and
//     the value as the issuer tagged it (STOR-06, DATA-06). The screen renders it as a muted
//     second line under each cell, and `Enter` opens the filing.
//
// `fieldIds(assetClass)` is intersected with `core/fields/dictionary.ts` exactly as DES.ts explains:
// an id the dictionary does not carry resolves to no `field_licence` row and is denied
// `FIELD_UNKNOWN`, which is an audit row that teaches nobody anything. `FA_FILED_AT`,
// `TOTAL_EQUITY`, `FREE_CASH_FLOW`, `RETURN_COM_EQY` and `GROSS_PROFIT` are named by the tier
// document and are not in the dictionary's 307 ids; the filter drops them.

import { z } from 'zod';

import { getField } from '../../fields/dictionary.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import {
  defineFunction,
  type CsvColumn,
  type CsvDocument,
  type KeyBinding,
  type LiveSpec,
} from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§FA L20-29)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FaStatements = ['IS', 'BS', 'CF', 'RATIOS', 'PER_SHARE', 'SEGMENTS'] as const;
export type FaStatement = (typeof FaStatements)[number];

export const FaParams = z.object({
  statement: z.enum(FaStatements).default('IS'),
  periodType: z.enum(['Q', 'FY', 'TTM']).default('FY'),
  periods: z.number().int().min(2).max(16).default(8),
  /** Show the XBRL concept behind every standardised cell (STOR-06, DATA-06). */
  asReported: z.boolean().default(false),
  scale: z.enum(['1', '1e3', '1e6', '1e9']).default('1e6'),
  /** PIT override; undefined = `ctx.asOf.knownAt`. Never later than it (STOR-06). */
  knownAt: z.iso.datetime().optional(),
});
export type FaParams = z.infer<typeof FaParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§FA L32-63)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One fiscal period: a column of the grid and the filing behind it. */
export interface FaColumn {
  periodEnd: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  filedAt: string;
  accessionNo: string;
  form: string;
  /** A later `filed_at` version of this `period_end` was also public at `knownAt`. */
  restated: boolean;
  derivedQ4: boolean;
  provIdx: number;
}

/** The as-reported drill of one standardised cell. */
export interface FaAsReported {
  concept: string;
  taxonomy: string;
  factId: number;
  value: number;
}

/** One standardised line. `values` is UNscaled — the screen divides by `scale`. */
export interface FaRow {
  /** `xbrl_concept_map.standard_item`, or a derived id (`GROSS_MARGIN`, `BVPS`). */
  item: string;
  label: string;
  indent: 0 | 1 | 2;
  unit: 'ccy' | 'shares' | 'per_share' | 'ratio' | 'pct';
  /** One per column, UNscaled. */
  values: (number | null)[];
  /** One per column; every entry `null` when `params.asReported` is false. */
  asReported: (FaAsReported | null)[];
  /** The dictionary field with the same meaning, where one exists. */
  fieldId: FieldId | null;
}

export interface FaEquityPayload {
  variant: 'equity';
  issuer: {
    issuerId: number;
    name: string;
    cik: string;
    /** `'MMDD'`. */
    fiscalYearEnd: string | null;
    currency: string;
  };
  statement: FaStatement;
  periodType: 'Q' | 'FY' | 'TTM';
  /** `Number(params.scale)`. */
  scale: number;
  columns: FaColumn[];
  rows: FaRow[];
  knownAt: string;
  /** `fin_statements.mapping_version` — `'std-map/2026.09'` (STOR-06). */
  mappingVersion: string;
  engine: { name: 'fundamentals/std-map'; version: string };
  notes: string[];
}

export interface FaHoldingRow {
  instrumentId: number | null;
  key: string | null;
  name: string;
  weight: number;
  marketValue: number | null;
}

export interface FaFundPayload {
  variant: 'fund';
  fund: {
    instrumentId: number;
    key: string;
    name: string;
    fundType: string;
    sponsor: string | null;
    cik: string | null;
    expenseRatio: number | null;
    inceptionDate: string | null;
    distributionFreq: string | null;
    trackedIndex: { instrumentId: number; key: string } | null;
  };
  nav: { px: ValueCell; chgPct: ValueCell };
  holdings: {
    asOfDate: string;
    sourceId: string;
    count: number;
    netAssets: number | null;
    top10: FaHoldingRow[];
    byAssetCat: { assetCat: string; weight: number; count: number }[];
    provIdx: number;
  } | null;
  /** Last 8 NPORT-P / N-CEN / N-30D / 485BPOS. */
  filings: {
    accessionNo: string;
    form: string;
    filedAt: string;
    reportDate: string | null;
    url: string;
  }[];
  notes: string[];
}

export type FaPayload = FaEquityPayload | FaFundPayload;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The standard rows per statement (§FA L65-71)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A row template: everything about a line except the numbers. */
export interface FaRowDef {
  item: string;
  label: string;
  indent: 0 | 1 | 2;
  unit: FaRow['unit'];
  fieldId: FieldId | null;
}

const row = (
  item: string,
  label: string,
  unit: FaRow['unit'],
  indent: 0 | 1 | 2 = 0,
  fieldId: FieldId | null = null,
): FaRowDef => ({
  item,
  label,
  indent,
  unit,
  // A dictionary id the dictionary does not have is not an id: the drill-down and the entitlement
  // check both resolve it, and both would report FIELD_UNKNOWN.
  fieldId: fieldId !== null && getField(fieldId) !== undefined ? fieldId : null,
});

/**
 * Screen order per statement. `RATIOS` and `PER_SHARE` are derived by the resolver from the same
 * `fin_statements` row the `IS` columns come from, which is why neither needs a second read.
 */
export const FA_ROWS: Readonly<Record<FaStatement, readonly FaRowDef[]>> = Object.freeze({
  IS: [
    row('REVENUE', 'Revenue', 'ccy', 0, 'SALES_REV_TURN'),
    row('COGS', 'Cost of goods sold', 'ccy', 1),
    row('GROSS_PROFIT', 'Gross profit', 'ccy', 0),
    row('OPEX', 'Operating expenses', 'ccy', 1),
    row('RND', 'Research and development', 'ccy', 2),
    row('OPER_INC', 'Operating income', 'ccy', 0, 'IS_OPER_INC'),
    row('INT_EXP', 'Interest expense', 'ccy', 1),
    row('PRETAX_INC', 'Pre-tax income', 'ccy', 0),
    row('TAX', 'Income tax', 'ccy', 1),
    row('NET_INC', 'Net income', 'ccy', 0, 'NET_INCOME'),
    row('EPS_BASIC', 'EPS, basic', 'per_share', 1, 'EPS_BASIC'),
    row('EPS_DIL', 'EPS, diluted', 'per_share', 1, 'IS_EPS_DIL'),
    row('SHARES_DIL', 'Diluted shares', 'shares', 1),
  ],
  BS: [
    row('CASH', 'Cash and equivalents', 'ccy', 1),
    row('TOT_ASSETS', 'Total assets', 'ccy', 0, 'BS_TOT_ASSET'),
    row('TOT_LIAB', 'Total liabilities', 'ccy', 0, 'BS_TOT_LIAB2'),
    row('LT_DEBT', 'Long-term debt', 'ccy', 1),
    row('EQUITY', 'Total equity', 'ccy', 0),
  ],
  CF: [
    row('CFO', 'Cash from operations', 'ccy', 0, 'CF_CASH_FROM_OPER'),
    row('CAPEX', 'Capital expenditure', 'ccy', 1, 'CF_CAP_EXPEND'),
    row('FCF', 'Free cash flow', 'ccy', 0),
    row('DIV_PAID', 'Dividends paid', 'ccy', 1),
    row('BUYBACK', 'Share buybacks', 'ccy', 1),
    row('DDA', 'Depreciation and amortisation', 'ccy', 1),
  ],
  RATIOS: [
    row('GROSS_MARGIN', 'Gross margin', 'pct'),
    row('OPER_MARGIN', 'Operating margin', 'pct'),
    row('NET_MARGIN', 'Net margin', 'pct', 0, 'NET_MARGIN'),
    row('FCF_MARGIN', 'Free cash flow margin', 'pct'),
    row('ROE', 'Return on equity', 'pct'),
    row('ROA', 'Return on assets', 'pct'),
    row('DEBT_TO_EQUITY', 'Long-term debt to equity', 'ratio'),
    row('PAYOUT', 'Dividend payout', 'pct'),
  ],
  PER_SHARE: [
    row('EPS_BASIC', 'EPS, basic', 'per_share', 0, 'EPS_BASIC'),
    row('EPS_DIL', 'EPS, diluted', 'per_share', 0, 'IS_EPS_DIL'),
    row('DPS', 'Dividends per share', 'per_share'),
    row('BVPS', 'Book value per share', 'per_share'),
    row('FCFPS', 'Free cash flow per share', 'per_share'),
    row('SALES_PS', 'Revenue per share', 'per_share', 0, 'SALES_PS'),
  ],
  SEGMENTS: [],
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fieldIds (§FA L95)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const known = (ids: readonly string[]): FieldId[] =>
  ids.filter((id): id is FieldId => getField(id) !== undefined);

const FA_EQUITY_FIELD_IDS: FieldId[] = known([
  'SALES_REV_TURN',
  'GROSS_PROFIT',
  'IS_OPER_INC',
  'NET_INCOME',
  'IS_EPS_DIL',
  'BS_TOT_ASSET',
  'BS_TOT_LIAB2',
  'TOTAL_EQUITY',
  'CF_CASH_FROM_OPER',
  'CF_CAP_EXPEND',
  'FREE_CASH_FLOW',
  'DVD_SH_12M',
  'RETURN_COM_EQY',
  'FA_FILED_AT',
]);

/**
 * The fund variant's pre-check is the **plant-served** fields only — not the tier document's
 * `[PX_LAST, CHG_PCT_1D, NAME, IDX_MEMBER_WEIGHT]`.
 *
 * DES.ts states the rule and FA is the second screen to meet it: the runner's step-5 decision also
 * produces the tier `buildContext` gates the plant with, and `effectiveTier` is the **minimum**
 * over the fields asked about. `NAME` is sourced from `openfigi.mapping` and `IDX_MEMBER_WEIGHT`
 * from `sec.archives`, both capped at `eod` in `licence_registry`; asking about them alongside
 * `PX_LAST` drops the decision to `eod`, and `policyTier.view` then freezes the NAV block on the
 * official close — which for a fund with no built `EodView` means the two cells this screen exists
 * to show come back `null`/`TIER_EOD`. Asserted by `FA.test.ts`'s fund case, which is how it was
 * found.
 *
 * Nothing is un-audited by the narrowing: the fund's name, terms, holdings and filings are read
 * through `DataServices`, which refuse to be constructed without a decision of their own.
 */
const FA_FUND_FIELD_IDS: FieldId[] = known(['PX_LAST', 'CHG_PCT_1D']);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§FA L150-153)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const FUND_CSV_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'value', label: 'Value', type: 'string' },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'asOf', label: 'As of', type: 'string' },
  { id: 'source', label: 'Source', type: 'string' },
];

/** `item,label,unit` plus one column per fiscal period — so the columns depend on the payload. */
export function faCsvColumns(payload: FaPayload): CsvColumn[] {
  if (payload.variant === 'fund') return FUND_CSV_COLUMNS;
  return [
    { id: 'item', label: 'Item', type: 'string' },
    { id: 'label', label: 'Label', type: 'string' },
    { id: 'unit', label: 'Unit', type: 'string' },
    ...payload.columns.map((c): CsvColumn => ({ id: c.periodEnd, label: c.periodEnd, type: 'number' })),
  ];
}

/**
 * Values at full stored precision (rule 2: the CSV does not scale), then two extra rows whose
 * `item` is `_FILED_AT` / `_ACCESSION` — the provenance of each column, in the column's own cell.
 */
export function faCsvRows(payload: FaPayload): CsvDocument['rows'] {
  if (payload.variant === 'fund') return faFundCsvRows(payload);
  const rows: CsvDocument['rows'] = payload.rows.map((r) => [
    r.item,
    r.label,
    r.unit,
    ...r.values.map((v) => v),
  ]);
  rows.push(['_FILED_AT', 'Filed at', 'date', ...payload.columns.map((c) => c.filedAt)]);
  rows.push(['_ACCESSION', 'Accession no', 'text', ...payload.columns.map((c) => c.accessionNo)]);
  return rows;
}

function faFundCsvRows(payload: FaFundPayload): CsvDocument['rows'] {
  const f = payload.fund;
  const asOf = payload.holdings?.asOfDate ?? '';
  const source = payload.holdings?.sourceId ?? '';
  const rows: CsvDocument['rows'] = [
    ['fund', 'sponsor', f.sponsor, 'text', '', 'sec.submissions'],
    ['fund', 'fundType', f.fundType, 'text', '', 'sec.submissions'],
    ['fund', 'expenseRatio', f.expenseRatio, 'ratio', '', 'sec.submissions'],
    ['fund', 'inceptionDate', f.inceptionDate, 'date', '', 'sec.submissions'],
    ['fund', 'distributionFreq', f.distributionFreq, 'text', '', 'sec.submissions'],
    ['fund', 'trackedIndex', f.trackedIndex?.key ?? null, 'text', '', 'sec.submissions'],
    ['nav', 'PX_LAST', payload.nav.px.v, 'px', '', 'cboe.quotes'],
    ['nav', 'CHG_PCT_1D', payload.nav.chgPct.v, 'pct', '', 'cboe.quotes'],
  ];
  for (const h of payload.holdings?.top10 ?? []) {
    rows.push(['top10', h.key ?? h.name, h.weight, 'ratio', asOf, source]);
  }
  for (const c of payload.holdings?.byAssetCat ?? []) {
    rows.push(['assetCat', c.assetCat, c.weight, 'ratio', asOf, source]);
  }
  for (const filing of payload.filings) {
    rows.push(['filings', filing.form, filing.url, 'text', filing.filedAt, 'sec.submissions']);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keyboard (§FA L129-141)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const FA_KEYMAP: readonly KeyBinding[] = [
  ...FaStatements.map((statement, i) => ({
    key: String(i + 1),
    action: 'tab-statement',
    when: 'always' as const,
    description: `Show ${statement.replace('_', ' ')}`,
  })),
  { key: 'P', action: 'cycle-period-type', when: 'always', description: 'FY → Q → TTM' },
  { key: 'R', action: 'toggle-as-reported', when: 'always', description: 'Show XBRL concepts' },
  { key: 'K', action: 'set-known-at', when: 'always', description: 'Set the point-in-time date' },
  { key: 'S', action: 'cycle-scale', when: 'always', description: 'Cycle the numeric scale' },
  { key: '+', action: 'more-periods', when: 'grid', description: 'Four more periods' },
  { key: '-', action: 'fewer-periods', when: 'grid', description: 'Four fewer periods' },
  { key: 'Enter', action: 'show-fact', when: 'grid', description: 'Open the XBRL fact behind the cell' },
  {
    key: 'Shift+Enter',
    action: 'open-filing-next',
    when: 'grid',
    description: 'Open the cash flow statement in the next panel',
  },
  { key: 'E', action: 'open-ee', when: 'always', description: 'Open EE (earnings)' },
  { key: 'V', action: 'open-rv', when: 'always', description: 'Open RV (relative valuation)' },
  { key: 'G', action: 'open-gp', when: 'always', description: 'Open GP (price chart)' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FA = defineFunction<typeof FaParams, FaPayload>({
  code: 'FA',
  name: 'Financial Analysis',
  aliases: ['FIN'],
  tier: 2,
  category: 'fundamentals',
  assetClasses: ['equity', 'etf'],
  requiresSecurity: true,
  variants: { equity: 'equity', etf: 'fund' },
  params: FaParams,
  paramGrammar: {
    positional: [
      { name: 'statement', type: 'enum', values: FaStatements, optional: true },
      { name: 'periodType', type: 'enum', values: ['Q', 'FY', 'TTM'], optional: true },
    ],
    keyed: {
      AR: { name: 'asReported', type: 'boolean' },
      N: { name: 'periods', type: 'int' },
      SCALE: { name: 'scale', type: 'enum', values: ['1', '1e3', '1e6', '1e9'] },
      KNOWN: { name: 'knownAt', type: 'datetime' },
    },
  },
  fieldIds: (assetClass): FieldId[] =>
    assetClass === 'etf' ? [...FA_FUND_FIELD_IDS] : [...FA_EQUITY_FIELD_IDS],
  pageable: false,
  // The equity screen is a static point-in-time grid: nothing on the wire can change a filed
  // number. The fund screen's NAV block is two plant cells, and only those two.
  live: (_params, payload): LiveSpec | null =>
    payload.variant === 'fund'
      ? {
          subjects: [`q:${String(payload.fund.instrumentId)}`],
          fields: ['PX_LAST', 'CHG_PCT_1D'],
          conflationMs: 1000,
        }
      : null,
  csv: {
    filename: (params, ctx): string => {
      const display = (ctx.display ?? 'security').replace(/ /g, '_');
      const asOf = ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      return `FA_${params.statement}_${display}_${asOf}.csv`;
    },
    columns: (_params, payload): CsvColumn[] => faCsvColumns(payload),
    rows: (payload): CsvDocument['rows'] => faCsvRows(payload),
  },
  help: {
    summary: 'Standardised income statement, balance sheet, cash flow and ratios from SEC XBRL',
    description:
      'FA shows standardised financial statements built from SEC EDGAR companyfacts through the ' +
      'concept map (std-map). Columns are fiscal periods; every column cites the filing it came ' +
      'from. The screen is point-in-time: press K to set the "known at" date and see the ' +
      'statements as they were filed then, restated columns are marked R. Press R to see the ' +
      'as-reported XBRL concept behind each standardised line. Segments are unavailable because ' +
      'companyfacts carries no dimensional facts. On an ETF the screen shows sponsor terms, NAV ' +
      'and the latest holdings file instead of statements.',
    params: [
      { name: 'statement', text: 'IS, BS, CF, RATIOS, PER_SHARE or SEGMENTS', example: 'FA BS' },
      { name: 'periodType', text: 'Q, FY or TTM', example: 'FA IS Q' },
      { name: 'periods', text: '2-16 columns', example: 'N=12' },
      { name: 'asReported', text: 'show XBRL concepts', example: 'AR=1' },
      { name: 'scale', text: '1, 1e3, 1e6, 1e9', example: 'SCALE=1e9' },
      { name: 'knownAt', text: 'point-in-time date', example: 'KNOWN=2026-06-01' },
    ],
    keys: FA_KEYMAP.map((k) => ({ key: k.key, action: k.description })),
    sources: ['sec.companyfacts', 'sec.submissions', 'sec.archives', 'ssga.holdings'],
    related: ['EE', 'RV', 'CF', 'DES', 'EQS'],
  },
  keymap: FA_KEYMAP,
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default FA;
