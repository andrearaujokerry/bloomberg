// packages/core/src/fields/defs/portfolio.ts — field_class 'portfolio'
//
// Tenant analytics computed over a firm's own positions (API.md §7, FUNCTIONS_TIER2 §PORT). They
// are a separate field class because they are a separate entitlement dimension: portfolio data
// never leaves the firm, is never licensed from a provider, and is never exported outside it
// (PORT-07). Every one of them is sourced from `internal.user` — the firm's own upload — rather
// than from a market source, which is what keeps `field_licence` honest about who owns the number.
//
// WP-01 seeded this file empty because CONTRACTS §4.3 declares none of the class; the eight ids
// below arrive with WP-10's `PORT` function, which is the first thing in the system that computes
// them (FUNCTIONS_TIER2 L1417-1428 names them and fixes their derivations).
//
// Two conventions, both taken from that table and both worth stating once:
//
//  * **Weights are gross weights.** `PORT_WEIGHT` is `PORT_MV / totals.grossMv`, so a short adds
//    to the denominator instead of cancelling a long, and the column sums to 100 % over the
//    non-cash book. `PORT_ACTIVE_WEIGHT` is that weight minus the benchmark's, and a held name
//    that is absent from the benchmark carries a benchmark weight of zero, never null — the
//    active weight of an off-benchmark position is the position itself.
//  * **`updateFreq` is `'tick'`, where FUNCTIONS_TIER2 says "realtime".** `FieldUpdateFreq` has no
//    `'realtime'` member (core/types/fields.ts); `'tick'` is the same statement in the vocabulary
//    the dictionary actually has — the value moves with every price the plant publishes for the
//    underlying holding. The four daily ids (beta, contribution to tracking error, VaR and active
//    weight) move only when the overnight bar series or the benchmark membership does.
//
// `assetClasses` lists all ten because the FUNCTIONS_TIER2 table says `*`: a portfolio holds
// whatever a desk bought, and the market value of a bond line is the same field as the market
// value of an equity line. `sources[].assetClass` is `'*'` too, so `buildFieldLicenceRows`
// expands each field to one `field_licence` row per asset class (providers/licences.ts).

import type { AssetClass } from '../../types/instrument.js';
import type { FieldDef } from '../../types/fields.js';

type FieldSource = FieldDef['sources'][number];

const SINCE = '2026.09.1';

/** `*` in the FUNCTIONS_TIER2 table: a portfolio line is a line whatever it holds. */
const ALL: readonly AssetClass[] = [
  'equity',
  'etf',
  'index',
  'fx',
  'govt',
  'option',
  'future',
  'crypto',
  'rate',
  'econ',
];

/**
 * The single source every id in this class carries: the firm's own positions, priced by the
 * terminal. `endpoint` is the table the quantity came from and `providerPath` the module that
 * turns it into a number, exactly as FUNCTIONS_TIER2 L1417 specifies.
 */
const POSITIONS: readonly FieldSource[] = [
  {
    assetClass: '*',
    sourceId: 'internal.user',
    endpoint: 'positions',
    providerPath: 'core/analytics/portfolio',
  },
];

const field = (
  id: string,
  label: string,
  definition: string,
  spec: {
    unit: FieldDef['unit'];
    decimals: number | null;
    updateFreq: FieldDef['updateFreq'];
    derivation: string;
    example: FieldDef['example'];
  },
): FieldDef => ({
  id,
  label,
  definition,
  type: 'number',
  unit: spec.unit,
  decimals: spec.decimals,
  fieldClass: 'portfolio',
  assetClasses: ALL,
  sources: POSITIONS,
  updateFreq: spec.updateFreq,
  pit: false,
  derivation: spec.derivation,
  example: spec.example,
  since: SINCE,
});

/** The eight `PORT_*` ids of FUNCTIONS_TIER2 L1417-1428, in dictionary (alphabetical) order. */
export const portfolioFields: readonly FieldDef[] = [
  field(
    'PORT_ACTIVE_WEIGHT',
    'Active weight',
    'A holding’s portfolio weight minus its weight in the portfolio’s benchmark, in ' +
      'percent. A name the benchmark does not hold carries a benchmark weight of zero, so its ' +
      'active weight is its whole position weight; a benchmark constituent the portfolio does ' +
      'not hold appears with a negative active weight. Null only when the portfolio has no ' +
      'benchmark at all.',
    {
      unit: 'pct',
      decimals: 2,
      updateFreq: 'daily',
      derivation: 'PORT_WEIGHT − benchmark weight (index_members.weight / etf_holdings.weight)',
      example: { ref: 'AAPL US Equity', value: 3.41, asOf: '2026-09-15' },
    },
  ),
  field(
    'PORT_BETA',
    'Portfolio beta',
    'Ordinary-least-squares slope of the portfolio’s daily returns on the benchmark’s ' +
      'daily returns over the risk window (252 sessions by default), on simple returns of ' +
      'split-adjusted closes. Null when fewer than 200 sessions overlap.',
    {
      unit: 'ratio',
      decimals: 3,
      updateFreq: 'daily',
      derivation: 'OLS slope of portfolio vs benchmark daily returns (core/analytics/stats#beta)',
      example: { ref: 'AAPL US Equity', value: 1.043, asOf: '2026-09-15' },
    },
  ),
  field(
    'PORT_CONTRIB_TE',
    'Contribution to tracking error',
    'On a position row, that position’s share of the portfolio’s ex-post tracking ' +
      'error, in percent; on the totals row, the tracking error itself — the standard ' +
      'deviation of the daily active (portfolio minus benchmark) return series, annualised by ' +
      '√252 and expressed in percent. The row contributions sum to the total.',
    {
      unit: 'pct',
      decimals: 2,
      updateFreq: 'daily',
      derivation:
        'stdev(portfolio − benchmark daily returns) × √252 × 100 ' +
        '(core/analytics/portfolio/risk.ts#trackingError)',
      example: { ref: 'AAPL US Equity', value: 0.57, asOf: '2026-09-15' },
    },
  ),
  field(
    'PORT_MV',
    'Market value',
    'A holding’s market value in the portfolio’s base currency, signed — negative ' +
      'for a short. Quantity times last price times the FX rate from the quoted currency into the ' +
      'base currency; a cash line is its quantity converted at the same rate. Null when the ' +
      'holding carries no price or no FX pair, never zero.',
    {
      unit: 'ccy',
      decimals: 2,
      updateFreq: 'tick',
      derivation: 'quantity × PX_LAST × FX_USD, in the portfolio base currency',
      example: { ref: 'AAPL US Equity', value: 294_372, asOf: '2026-09-15' },
    },
  ),
  field(
    'PORT_PNL_1D',
    'Day P&L',
    'The holding’s profit or loss over the current session in the portfolio’s base ' +
      'currency: quantity times the session net change times the FX rate. Signed, and negative ' +
      'for a long position in a falling name.',
    {
      unit: 'ccy',
      decimals: 2,
      updateFreq: 'tick',
      derivation: 'quantity × CHG_NET_1D × FX_USD, in the portfolio base currency',
      example: { ref: 'AAPL US Equity', value: -1_284.6, asOf: '2026-09-15' },
    },
  ),
  field(
    'PORT_UNREAL_PNL',
    'Unrealised P&L',
    'Mark-to-market gain or loss on the holding against its lot-weighted cost price, in the ' +
      'portfolio’s base currency. Null when the position carries no cost price — an ' +
      'unknown cost basis is absent, not zero.',
    {
      unit: 'ccy',
      decimals: 2,
      updateFreq: 'tick',
      derivation: 'quantity × (PX_LAST − costPrice) × FX_USD',
      example: { ref: 'AAPL US Equity', value: 69_465, asOf: '2026-09-15' },
    },
  ),
  field(
    'PORT_VAR',
    'Value at Risk (1 day)',
    'One-day value at risk of the portfolio at the requested confidence, as a positive percentage ' +
      'of portfolio value. The historical method takes the (100 − confidence)-th percentile ' +
      'of the realised daily return series; the parametric method takes z(confidence) times the ' +
      'daily standard deviation.',
    {
      unit: 'pct',
      decimals: 2,
      updateFreq: 'daily',
      derivation: '1-day VaR at varConfidence by varMethod (core/analytics/portfolio/risk.ts)',
      example: { ref: 'AAPL US Equity', value: 1.86, asOf: '2026-09-15' },
    },
  ),
  field(
    'PORT_WEIGHT',
    'Portfolio weight',
    'The holding’s share of gross market value, in percent: the absolute market value over ' +
      'the sum of absolute market values across the non-cash book, so a short contributes ' +
      'positively to the denominator and the column sums to 100.',
    {
      unit: 'pct',
      decimals: 2,
      updateFreq: 'tick',
      derivation: '|PORT_MV| / totals.grossMv × 100',
      example: { ref: 'AAPL US Equity', value: 9.12, asOf: '2026-09-15' },
    },
  ),
];
