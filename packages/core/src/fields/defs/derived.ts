// packages/core/src/fields/defs/derived.ts — field_class 'derived'
//
// Values the terminal computes from other fields by a fixed arithmetic rule, with no model and no
// convention to choose. They are never taken from a provider even when a provider publishes one:
// a change on the screen must always equal PX_LAST − PX_CLOSE_1D of the same snapshot, and the only
// way to guarantee that is to compute it here (ARCHITECTURE §5.3).

import type { FieldDef } from '../../types/fields.js';

type FieldSource = FieldDef['sources'][number];

const src = (
  assetClass: FieldSource['assetClass'],
  sourceId: string,
  endpoint: string,
  providerPath: string,
): FieldSource => ({ assetClass, sourceId, endpoint, providerPath });

const SINCE = '2026.09.1';
const QUOTED_WIDE = ['equity', 'etf', 'index', 'fx', 'crypto'] as const;
const ISSUER = ['equity', 'etf'] as const;

const derive = (path: string): FieldSource[] => [src('*', 'internal.derived', 'derive', path)];

export const derivedFields: readonly FieldDef[] = [
  {
    id: 'CHG_NET_1D',
    label: 'Net change',
    definition:
      'PX_LAST minus PX_CLOSE_1D, in the instrument currency, from one and the same quote snapshot. ' +
      'Unavailable rather than zero when either input is missing.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'derived',
    assetClasses: [...QUOTED_WIDE, 'option'],
    sources: derive('core/quote/derive.ts#netChange'),
    updateFreq: 'tick',
    pit: false,
    derivation: 'PX_LAST − PX_CLOSE_1D',
    example: { ref: 'AAPL US Equity', value: 1.36, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'CHG_PCT_1D',
    label: 'Percent change',
    definition:
      'CHG_NET_1D as a percentage of PX_CLOSE_1D. The previous close is unadjusted, so on an ' +
      'ex-dividend or split date the change is the raw one the tape shows, and the corporate ' +
      'action is flagged on the line.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'derived',
    assetClasses: [...QUOTED_WIDE, 'option'],
    sources: derive('core/quote/derive.ts#percentChange'),
    updateFreq: 'tick',
    pit: false,
    derivation: '(PX_LAST − PX_CLOSE_1D) / PX_CLOSE_1D × 100',
    example: { ref: 'AAPL US Equity', value: 0.41, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'PX_HIGH_52W',
    label: '52-week high',
    definition:
      'Highest daily high of the trailing 52 weeks ending at validAt, adjusted for splits but not ' +
      'for dividends, from bars_daily.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'derived',
    assetClasses: [...QUOTED_WIDE],
    sources: derive('core/quote/window.ts#high52w'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'max(PX_HIGH) over the trailing 252 sessions, split-adjusted',
    example: { ref: 'AAPL US Equity', value: 341.12, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'PX_LOW_52W',
    label: '52-week low',
    definition:
      'Lowest daily low of the trailing 52 weeks ending at validAt, adjusted for splits but not ' +
      'for dividends, from bars_daily.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'derived',
    assetClasses: [...QUOTED_WIDE],
    sources: derive('core/quote/window.ts#low52w'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'min(PX_LOW) over the trailing 252 sessions, split-adjusted',
    example: { ref: 'AAPL US Equity', value: 241.87, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'VOLUME_AVG_30D',
    label: 'Average volume (30d)',
    definition:
      'Arithmetic mean of PX_VOLUME over the last 30 completed sessions. Sessions with no trading ' +
      'are excluded rather than counted as zero.',
    type: 'number',
    unit: 'shares',
    decimals: 0,
    fieldClass: 'derived',
    assetClasses: [...QUOTED_WIDE],
    sources: derive('core/quote/window.ts#avgVolume'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'mean(PX_VOLUME) over the trailing 30 sessions',
    example: { ref: 'AAPL US Equity', value: 48213900, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'TOT_RETURN_INDEX',
    label: 'Total return index',
    definition:
      'Price series rebased to 100 at the start of the requested window with cash dividends ' +
      'reinvested at the ex-date close. The policy that produced it (price, total return, or ' +
      'split-only) is a parameter of the run and is echoed in meta.engines.',
    type: 'number',
    unit: 'ratio',
    decimals: 6,
    fieldClass: 'derived',
    assetClasses: [...QUOTED_WIDE],
    sources: derive('core/adjust/corporateActions.ts#totalReturnIndex'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'Π (1 + (P_t + D_t)/P_{t−1} − 1) rebased to 100 at the window start',
    example: { ref: 'AAPL US Equity', value: 118.412367, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'CUR_MKT_CAP',
    label: 'Market capitalisation',
    definition:
      'PX_LAST multiplied by EQY_SH_OUT, in the listing currency. It moves on every tick while the ' +
      'share count stays at the last filing, so it is point-in-time through its share input.',
    type: 'number',
    unit: 'ccy',
    decimals: 0,
    fieldClass: 'derived',
    assetClasses: [...ISSUER],
    sources: derive('core/quote/derive.ts#marketCap'),
    updateFreq: 'tick',
    pit: true,
    derivation: 'PX_LAST × EQY_SH_OUT',
    example: { ref: 'AAPL US Equity', value: 4900610000000, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'EQY_FLOAT_PCT',
    label: 'Free float',
    definition:
      'Publicly floated shares as a percentage of EQY_SH_OUT: shares outstanding less the holdings ' +
      'reported as restricted or insider-held in the latest filing.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'derived',
    assetClasses: [...ISSUER],
    sources: derive('core/reference/float.ts#floatPct'),
    updateFreq: 'on_filing',
    pit: true,
    derivation: 'PUBLIC_FLOAT / EQY_SH_OUT × 100',
    example: { ref: 'AAPL US Equity', value: 99.87, asOf: '2026-08-01' },
    since: SINCE,
  },
  {
    id: 'DVD_YIELD',
    label: 'Dividend yield',
    definition:
      'Trailing twelve-month cash dividends per share over PX_LAST, in percent. Zero-dividend ' +
      'issuers report 0, not unavailable.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'derived',
    assetClasses: [...ISSUER],
    sources: derive('core/quote/derive.ts#dividendYield'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'DVD_SH_12M / PX_LAST × 100',
    example: { ref: 'AAPL US Equity', value: 0.31, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'PX_TO_BOOK_RATIO',
    label: 'Price to book',
    definition:
      'CUR_MKT_CAP divided by total common equity of the most recent reported period. Negative ' +
      'book value yields an unavailable value rather than a negative ratio.',
    type: 'number',
    unit: 'ratio',
    decimals: 2,
    fieldClass: 'derived',
    assetClasses: [...ISSUER],
    sources: derive('core/analytics/ratios.ts#priceToBook'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'CUR_MKT_CAP / (TOT_ASSETS − TOT_LIAB)',
    example: { ref: 'AAPL US Equity', value: 73.12, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'PX_TO_SALES_RATIO',
    label: 'Price to sales',
    definition: 'PX_LAST divided by SALES_PS, on trailing twelve-month revenue.',
    type: 'number',
    unit: 'ratio',
    decimals: 2,
    fieldClass: 'derived',
    assetClasses: [...ISSUER],
    sources: derive('core/analytics/ratios.ts#priceToSales'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'PX_LAST / SALES_PS',
    example: { ref: 'AAPL US Equity', value: 12.89, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'NET_MARGIN',
    label: 'Net margin',
    definition:
      'Net income over revenue for the same reported period, in percent. Both inputs come from one ' +
      'statement version, so a restatement moves them together.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'derived',
    assetClasses: [...ISSUER],
    sources: derive('core/analytics/ratios.ts#netMargin'),
    updateFreq: 'quarterly',
    pit: true,
    derivation: 'NET_INC / SALES_REV_TURN × 100',
    example: { ref: 'AAPL US Equity', value: 24.9, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'SALES_GROWTH_YOY',
    label: 'Revenue growth (YoY)',
    definition:
      'Revenue of the period over revenue of the same period one year earlier, minus one, in ' +
      'percent. The comparison period is matched on fiscal period, not on calendar date.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'derived',
    assetClasses: [...ISSUER],
    sources: derive('core/analytics/ratios.ts#salesGrowthYoY'),
    updateFreq: 'quarterly',
    pit: true,
    derivation: 'SALES_REV_TURN(t) / SALES_REV_TURN(t − 4 quarters) − 1, ×100',
    example: { ref: 'AAPL US Equity', value: 9.63, asOf: '2026-06-27' },
    since: SINCE,
  },
  {
    id: 'FX_USD',
    label: 'FX rate to USD',
    definition:
      'Rate used to convert one unit of the instrument currency into USD for the run, taken from ' +
      'the fx_rates row valid at the analytic date. Published so a converted figure can be undone.',
    type: 'number',
    unit: 'ratio',
    decimals: 6,
    fieldClass: 'derived',
    assetClasses: [...QUOTED_WIDE, 'govt', 'option'],
    sources: derive('core/fx/convert.ts#rateToBase'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'fx_rates(ccy → USD) on or before the analytic date',
    example: { ref: 'SAP GY Equity', value: 1.086412, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'FX_MISSING',
    label: 'FX rate missing',
    definition:
      'True when no fx_rates row existed for the instrument currency on or before the analytic ' +
      'date, so the row could not be converted and was excluded from the totals. The reason ' +
      'travels with the row as NO_SOURCE on FX_USD.',
    type: 'boolean',
    unit: null,
    decimals: null,
    fieldClass: 'derived',
    assetClasses: [...QUOTED_WIDE, 'govt', 'option'],
    sources: derive('core/fx/convert.ts#rateToBase'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'FX_USD is null for the row’s currency at the analytic date',
    example: { ref: 'SAP GY Equity', value: false, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'IS_FINAL',
    label: 'Bar final',
    definition:
      'True once the interval of an intraday bar has closed and the bar will not be revised. The ' +
      'in-progress bar of the current interval is always false and is redrawn on every update.',
    type: 'boolean',
    unit: null,
    decimals: null,
    fieldClass: 'derived',
    assetClasses: [...QUOTED_WIDE],
    sources: derive('core/bars/intraday.ts#isFinal'),
    updateFreq: '1m',
    pit: false,
    derivation: 'barTs + interval ≤ validAt',
    example: { ref: 'AAPL US Equity', value: true, asOf: '2026-09-15T18:41:00Z' },
    since: SINCE,
  },

  // ── Harvested id kept for coverage (see reference.ts for why) ────────────────────────────────
  {
    id: 'CHG_',
    label: 'Change field family',
    definition:
      'Not a field: the CHG_* prefix, harvested from wildcard references to the change family (the ' +
      'cells that flash and carry a direction arrow). Use CHG_NET_1D or CHG_PCT_1D.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'derived',
    assetClasses: [],
    sources: [],
    updateFreq: 'static',
    pit: false,
    example: { ref: '-', value: 'CHG_*', asOf: '2026-09-17' },
    since: SINCE,
    deprecated: { since: SINCE, replacement: 'CHG_NET_1D', removeAfter: '2027.01.1' },
  },
];
