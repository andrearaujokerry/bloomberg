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

import type { FieldDef } from '../../types/fields.js';

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
