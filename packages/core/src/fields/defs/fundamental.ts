// packages/core/src/fields/defs/fundamental.ts — field_class 'fundamental'
//
// Reported financial-statement figures. Every one of them is point-in-time (STOR-06): the value for
// a period depends on which filing was known at `knownAt`, so a restatement creates a new version
// rather than overwriting the old one, and a chart drawn as of last year still shows last year's
// numbers.
//
// Two naming families live here on purpose:
//   * the screen-facing ids (BS_TOT_ASSET, NET_INCOME, IS_EPS_DIL, …) that manifests cite;
//   * the normalised `fin_statements.line_code` ids (TOT_ASSETS, TOT_LIAB, NET_INC, EPS_BASIC,
//     EPS_DIL) that the ratio engine and the FA templates compute from.
// They are separate ids because they are separate contracts: the first is a dictionary field with a
// licence row, the second is a row key inside a statement.

import type { FieldDef, FieldId } from '../../types/fields.js';

type FieldSource = FieldDef['sources'][number];

const src = (
  assetClass: FieldSource['assetClass'],
  sourceId: string,
  endpoint: string,
  providerPath: string,
): FieldSource => ({ assetClass, sourceId, endpoint, providerPath });

const SINCE = '2026.09.1';
const ISSUER = ['equity', 'etf'] as const;

const facts = (concept: string): FieldSource[] => [
  src('equity', 'sec.companyfacts', 'companyfacts', `facts.us-gaap.${concept}`),
];

export const fundamentalFields: readonly FieldDef[] = [
  {
    id: 'SALES_REV_TURN',
    label: 'Revenue',
    definition:
      'Total net revenue of the period as reported on the income statement, in the reporting ' +
      'currency. Quarterly values are the filed quarter, never a derived difference of year-to-date ' +
      'figures unless the filer reports only year-to-date.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('RevenueFromContractWithCustomerExcludingAssessedTax'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 94930000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'IS_OPER_INC',
    label: 'Operating income',
    definition:
      'Income from operations: revenue less cost of revenue and operating expenses, before ' +
      'non-operating items and tax, as reported.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('OperatingIncomeLoss'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 28200000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'NET_INCOME',
    label: 'Net income',
    definition:
      'Net income attributable to the parent for the period, after tax and minority interest, as ' +
      'reported on the income statement.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('NetIncomeLoss'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 23640000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'IS_EPS_DIL',
    label: 'Diluted EPS',
    definition:
      'Diluted earnings per share for the period as reported, on the share count the filer used. ' +
      'Prior periods carry the filer’s own retroactive split adjustment, not the terminal’s.',
    type: 'number',
    unit: 'ccy',
    decimals: 2,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('EarningsPerShareDiluted'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 1.57, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'BS_TOT_ASSET',
    label: 'Total assets',
    definition: 'Total assets on the balance sheet at the period end, as reported.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('Assets'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 331520000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'BS_TOT_LIAB2',
    label: 'Total liabilities',
    definition:
      'Total liabilities on the balance sheet at the period end. When the filer tags only ' +
      'LiabilitiesAndStockholdersEquity, the value is that figure less total equity, and the ' +
      'derivation is recorded in the statement provenance.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('Liabilities'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 264430000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'CF_CASH_FROM_OPER',
    label: 'Cash from operations',
    definition:
      'Net cash provided by operating activities for the period, from the cash-flow statement.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('NetCashProvidedByUsedInOperatingActivities'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 28900000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'CF_CAP_EXPEND',
    label: 'Capital expenditure',
    definition:
      'Payments to acquire property, plant and equipment for the period, reported as a positive ' +
      'outflow so that free cash flow is CF_CASH_FROM_OPER − CF_CAP_EXPEND.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('PaymentsToAcquirePropertyPlantAndEquipment'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 2960000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'DVD_SH_12M',
    label: 'Dividends per share (12M)',
    definition:
      'Sum of the cash dividends with an ex-date in the twelve months ending at validAt, per ' +
      'share, in the listing currency. Special dividends are included and flagged in provenance.',
    type: 'number',
    unit: 'ccy',
    decimals: 4,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: [src('*', 'yahoo.chart', 'chart', 'events.dividends')],
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 1.04, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'SALES_PS',
    label: 'Sales per share',
    definition:
      'Trailing twelve-month revenue divided by the diluted share count of the most recent ' +
      'reported period. The denominator of PX_TO_SALES_RATIO.',
    type: 'number',
    unit: 'ccy',
    decimals: 4,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: [src('equity', 'internal.derived', 'finStatements', 'ttm(REVENUE)/SHARES_DIL')],
    updateFreq: 'quarterly',
    pit: true,
    derivation: 'ttm(SALES_REV_TURN) / SHARES_DIL of the latest reported period',
    example: { ref: 'AAPL US Equity', value: 25.61, asOf: '2026-06-27' },
    since: SINCE,
  },

  // ── Normalised `fin_statements.line_code` ids (DATA_MODEL.md L1324) ──────────────────────────
  {
    id: 'TOT_ASSETS',
    label: 'Total assets (statement line)',
    definition:
      'The normalised balance-sheet line `TOT_ASSETS` of fin_statements, the row the ratio engine ' +
      'reads. Identical in meaning to BS_TOT_ASSET, which is the dictionary field a screen cites.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('Assets'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 331520000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'TOT_LIAB',
    label: 'Total liabilities (statement line)',
    definition:
      'The normalised balance-sheet line `TOT_LIAB` of fin_statements, the denominator of the ' +
      'leverage ratios. Identical in meaning to BS_TOT_LIAB2.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('Liabilities'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 264430000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'NET_INC',
    label: 'Net income (statement line)',
    definition:
      'The normalised income-statement line `NET_INC` of fin_statements: the numerator of ' +
      'NET_MARGIN, ROE and ROA. Identical in meaning to NET_INCOME.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('NetIncomeLoss'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 23640000000, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'EPS_BASIC',
    label: 'Basic EPS (statement line)',
    definition:
      'The normalised income-statement line `EPS_BASIC`: net income attributable to common ' +
      'shareholders divided by the weighted average basic share count, as reported.',
    type: 'number',
    unit: 'ccy',
    decimals: 2,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('EarningsPerShareBasic'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 1.59, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'EPS_DIL',
    label: 'Diluted EPS (statement line)',
    definition:
      'The normalised income-statement line `EPS_DIL`, the row FA and the EQS screener read. ' +
      'Identical in meaning to IS_EPS_DIL.',
    type: 'number',
    unit: 'ccy',
    decimals: 2,
    fieldClass: 'fundamental',
    assetClasses: [...ISSUER],
    sources: facts('EarningsPerShareDiluted'),
    updateFreq: 'quarterly',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 1.57, asOf: '2026-06-27' },
    since: SINCE,
  },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The `fin_statements` standard-item catalogue (DATA-06, PROVIDERS §7.3.1)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `xbrl_concept_map.standard_item` is a row key inside a statement, not a dictionary field: it has
// no licence row, no `assetClasses` and no `example`, and only nine of the twenty-five happen to
// have a dictionary field that means the same thing. What every one of them *does* have is a
// column in `fin_statements`, a numeric scale that column rounds to, the unit its facts are read
// in, and whether it is an instant (balance-sheet) or a duration (income/cash-flow) quantity.
//
// That is the table below. It lives here, beside the fundamental field defs, because it is the
// other half of the same vocabulary: `ingest/jobs/secCompanyFacts.ts` writes `fin_statements`
// through it and `functions/FA` reads the row back through it, so a scale or a unit is spelled
// once. It adds **no `FieldDef`** — the dictionary is a closed set of designed ids
// (`core/test/fields/dictionary.test.ts`) and a statement line is not one of them.
//
// Two of the twenty-five are computed rather than tagged (§7.3.1): `GROSS_PROFIT` falls back to
// `REVENUE − COGS` and `FCF` is always `CFO − |CAPEX|`. Their `computed` string is what
// `fin_statements.as_reported` records as the concept, so FA's "as reported" toggle can say that
// the issuer never tagged the line rather than showing a number with no filing behind it.

/** Which statement a standard item belongs to. Equals `fin_statements`'s `statement` CHECK. */
export type StatementKind = 'IS' | 'BS' | 'CF';

/** The unit an item's facts are read in — the `units` key of `facts.<tax>.<concept>.units`. */
export type StatementUnit = 'USD' | 'USD/shares' | 'shares';

/** One row of the standard-item catalogue. */
export interface StatementLineDef {
  /** `xbrl_concept_map.standard_item`. */
  standardItem: string;
  /** The `fin_statements` column, camel-cased exactly as the drizzle schema spells it. */
  column: string;
  statement: StatementKind;
  /** Column header. */
  label: string;
  /** The numeric scale of the column: `numeric(28,2)` ⇒ 2, `numeric(20,0)` ⇒ 0. */
  scale: number;
  unit: StatementUnit;
  /**
   * `true` for a balance-sheet quantity, which is read from an **instant** fact (`period_start`
   * NULL) at the period end rather than from the period's duration.
   */
  instant: boolean;
  /** The dictionary field with the same meaning, where one exists. */
  fieldId?: FieldId;
  /** Set when the item is derived rather than tagged; the string `as_reported` records. */
  computed?: string;
}

const line = (
  standardItem: string,
  column: string,
  statement: StatementKind,
  label: string,
  scale: number,
  unit: StatementUnit,
  instant: boolean,
  extra: { fieldId?: FieldId; computed?: string } = {},
): StatementLineDef => {
  const def: StatementLineDef = { standardItem, column, statement, label, scale, unit, instant };
  // `exactOptionalPropertyTypes`: an explicit `undefined` is not the same as an absent key.
  if (extra.fieldId !== undefined) def.fieldId = extra.fieldId;
  if (extra.computed !== undefined) def.computed = extra.computed;
  return def;
};

/** The twenty-five standard items, in statement order: IS, then BS, then CF. */
export const statementLines: readonly StatementLineDef[] = [
  line('REVENUE', 'revenue', 'IS', 'Revenue', 2, 'USD', false, { fieldId: 'SALES_REV_TURN' }),
  line('COGS', 'cogs', 'IS', 'Cost of revenue', 2, 'USD', false),
  line('GROSS_PROFIT', 'grossProfit', 'IS', 'Gross profit', 2, 'USD', false, {
    computed: 'computed:REVENUE-COGS',
  }),
  line('RND', 'rnd', 'IS', 'Research and development', 2, 'USD', false),
  line('OPEX', 'opex', 'IS', 'Operating expenses', 2, 'USD', false),
  line('OPER_INC', 'operInc', 'IS', 'Operating income', 2, 'USD', false, {
    fieldId: 'IS_OPER_INC',
  }),
  line('INT_EXP', 'intExp', 'IS', 'Interest expense', 2, 'USD', false),
  line('PRETAX_INC', 'pretaxInc', 'IS', 'Pre-tax income', 2, 'USD', false),
  line('TAX', 'tax', 'IS', 'Income tax expense', 2, 'USD', false),
  line('NET_INC', 'netInc', 'IS', 'Net income', 2, 'USD', false, { fieldId: 'NET_INC' }),
  line('EPS_BASIC', 'epsBasic', 'IS', 'Basic EPS', 4, 'USD/shares', false, {
    fieldId: 'EPS_BASIC',
  }),
  line('EPS_DIL', 'epsDil', 'IS', 'Diluted EPS', 4, 'USD/shares', false, { fieldId: 'EPS_DIL' }),
  line('SHARES_DIL', 'sharesDil', 'IS', 'Diluted shares', 0, 'shares', false),
  line('TOT_ASSETS', 'totAssets', 'BS', 'Total assets', 2, 'USD', true, { fieldId: 'TOT_ASSETS' }),
  line('TOT_LIAB', 'totLiab', 'BS', 'Total liabilities', 2, 'USD', true, { fieldId: 'TOT_LIAB' }),
  line('EQUITY', 'equity', 'BS', "Shareholders' equity", 2, 'USD', true),
  line('CASH', 'cash', 'BS', 'Cash and equivalents', 2, 'USD', true),
  line('LT_DEBT', 'ltDebt', 'BS', 'Long-term debt', 2, 'USD', true),
  line('CFO', 'cfo', 'CF', 'Cash from operations', 2, 'USD', false, {
    fieldId: 'CF_CASH_FROM_OPER',
  }),
  line('CAPEX', 'capex', 'CF', 'Capital expenditure', 2, 'USD', false, {
    fieldId: 'CF_CAP_EXPEND',
  }),
  line('FCF', 'fcf', 'CF', 'Free cash flow', 2, 'USD', false, {
    computed: 'computed:CFO-ABS(CAPEX)',
  }),
  line('DIV_PAID', 'divPaid', 'CF', 'Dividends paid', 2, 'USD', false),
  line('BUYBACK', 'buyback', 'CF', 'Share repurchases', 2, 'USD', false),
  line('DPS', 'dps', 'CF', 'Dividends per share declared', 6, 'USD/shares', false),
  line('DDA', 'dda', 'CF', 'Depreciation and amortisation', 2, 'USD', false),
];

const statementLineByItem: ReadonlyMap<string, StatementLineDef> = new Map(
  statementLines.map((def) => [def.standardItem, def]),
);

/** `undefined` for an item the catalogue does not know — a caller decides whether that is a bug. */
export function statementLine(standardItem: string): StatementLineDef | undefined {
  return statementLineByItem.get(standardItem);
}

/** The catalogue restricted to one statement, in catalogue order. */
export function statementLinesOf(statement: StatementKind): readonly StatementLineDef[] {
  return statementLines.filter((def) => def.statement === statement);
}
