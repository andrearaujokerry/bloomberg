// packages/core/src/fields/defs/analytic.ts — field_class 'analytic'
//
// Model output: a number that exists only because an engine computed it from market data plus a
// convention. Every entry carries `derivation` (ANAL-08) naming the engine, and every payload that
// shows one also carries that engine's name/version in `meta.engines`, so a value on the screen can
// always be traced back to the code that produced it.
//
// Provider-published greeks are analytic too (the venue ran the model, not us) — they are marked by
// their source being the option chain rather than `internal.derived`.

import type { FieldDef } from '../../types/fields.js';

type FieldSource = FieldDef['sources'][number];

const src = (
  assetClass: FieldSource['assetClass'],
  sourceId: string,
  endpoint: string,
  providerPath: string,
): FieldSource => ({ assetClass, sourceId, endpoint, providerPath });

const SINCE = '2026.09.1';
const REMOVE_AFTER = '2027.01.1';

const chain = (path: string): FieldSource[] => [
  src('option', 'cboe.options', 'options', `data.options[].${path}`),
];
const engine = (name: string): FieldSource[] => [src('*', 'internal.derived', 'analytics', name)];

export const analyticFields: readonly FieldDef[] = [
  // ── Fixed income (core/analytics/bond/*) ─────────────────────────────────────────────────────
  {
    id: 'YLD_YTM_MID',
    label: 'Yield to maturity (mid)',
    definition:
      'Annualised yield that discounts the remaining cash flows of the bond to its mid dirty price, ' +
      'on the issue’s own day-count and coupon frequency. Semi-annual bond-equivalent for US ' +
      'Treasury notes and bonds; discount-to-BEY conversion for bills.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/yield.ts#ytm'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'solve price(y) = PX_DIRTY_MID by Newton on the issue day-count (ACT/ACT for UST)',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 4.1832, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'PX_CLEAN_MID',
    label: 'Clean price (mid)',
    definition:
      'Mid price per 100 of face excluding accrued interest — the quoted price of the bond. ' +
      'PX_CLEAN_MID + ACCRUED = PX_DIRTY_MID by construction.',
    type: 'number',
    unit: 'price',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/price.ts#clean'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'PX_DIRTY_MID − ACCRUED',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 100.53125, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'PX_DIRTY_MID',
    label: 'Dirty price (mid)',
    definition:
      'Mid settlement price per 100 of face including accrued interest — what a buyer actually ' +
      'pays on the settlement date the analytic used.',
    type: 'number',
    unit: 'price',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/price.ts#dirty'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'PX_CLEAN_MID + ACCRUED at the T+1 settlement date',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 101.95321, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'ACCRUED',
    label: 'Accrued interest',
    definition:
      'Interest accrued per 100 of face from the last coupon date to the settlement date, on the ' +
      'issue’s day-count convention.',
    type: 'number',
    unit: 'price',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/accrued.ts#accruedInterest'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'coupon × dayCountFraction(lastCoupon, settle) on the issue convention',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 1.42196, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'DUR_MID',
    label: 'Macaulay duration',
    definition:
      'Cash-flow-weighted average time to receipt, in years, discounted at YLD_YTM_MID. Not a ' +
      'price sensitivity on its own — DUR_ADJ_MID is.',
    type: 'number',
    unit: 'years',
    decimals: 3,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/risk.ts#macaulay'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'Σ t·PV(cf_t) / Σ PV(cf_t) at y = YLD_YTM_MID',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 7.412, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'DUR_ADJ_MID',
    label: 'Modified duration',
    definition:
      'Percentage change in dirty price for a 100 bp parallel change in yield: Macaulay duration ' +
      'divided by (1 + y/f). The first-order risk number YAS and the curve screens quote.',
    type: 'number',
    unit: 'years',
    decimals: 3,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/risk.ts#modified'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'DUR_MID / (1 + YLD_YTM_MID/100 / CPN_FREQ)',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 7.259, asOf: '2026-09-15' },
    since: SINCE,
  },

  // ── Options: venue-published greeks (cboe.options) ───────────────────────────────────────────
  {
    id: 'OPT_IV',
    label: 'Implied volatility (venue)',
    definition:
      'Implied volatility of the series as published by the venue, annualised, in percent. It is ' +
      'the venue’s model on the venue’s inputs; OPT_IMPL_VOL_MID is the terminal’s own solve.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: chain('iv'),
    updateFreq: '1m',
    pit: false,
    derivation: 'venue-published; no terminal engine involved',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 27.14, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_DELTA',
    label: 'Delta',
    definition:
      'Change in the option’s value for a one-unit change in the underlying price, per contract ' +
      'unit. Positive for calls, negative for puts.',
    type: 'number',
    unit: 'ratio',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: chain('delta'),
    updateFreq: '1m',
    pit: false,
    derivation: '∂V/∂S — venue-published, reproduced by core/analytics/option/greeks.ts',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 0.4218, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_GAMMA',
    label: 'Gamma',
    definition: 'Change in delta for a one-unit change in the underlying price.',
    type: 'number',
    unit: 'ratio',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: chain('gamma'),
    updateFreq: '1m',
    pit: false,
    derivation: '∂²V/∂S²',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 0.008341, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_VEGA',
    label: 'Vega',
    definition:
      'Change in the option’s value for a one-percentage-point change in implied volatility.',
    type: 'number',
    unit: 'ratio',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: chain('vega'),
    updateFreq: '1m',
    pit: false,
    derivation: '∂V/∂σ per volatility point',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 0.6142, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_THETA',
    label: 'Theta',
    definition:
      'Change in the option’s value for the passage of one calendar day, holding everything else ' +
      'constant. Negative for a long option away from a dividend.',
    type: 'number',
    unit: 'ratio',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: chain('theta'),
    updateFreq: '1m',
    pit: false,
    derivation: '∂V/∂t per calendar day',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: -0.0873, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_RHO',
    label: 'Rho',
    definition:
      'Change in the option’s value for a one-percentage-point change in the discount rate.',
    type: 'number',
    unit: 'ratio',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: chain('rho'),
    updateFreq: '1m',
    pit: false,
    derivation: '∂V/∂r per rate point',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 0.7719, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_THEO',
    label: 'Theoretical value (venue)',
    definition:
      'Theoretical option value published by the venue alongside its greeks. Compare with ' +
      'OPT_MODEL_PX, which is the terminal’s own valuation on the terminal’s rate and dividend ' +
      'assumptions.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: chain('theo'),
    updateFreq: '1m',
    pit: false,
    derivation: 'venue-published theoretical value',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 18.42, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },

  // ── Options: terminal engine (core/analytics/option/*) ───────────────────────────────────────
  {
    id: 'OPT_IMPL_VOL_MID',
    label: 'Implied volatility (mid, computed)',
    definition:
      'Volatility that reprices the option to the mid of PX_BID and PX_ASK under the terminal’s ' +
      'Black-Scholes-Merton implementation, on OPT_RATE_USED and OPT_DVD_YIELD_USED. Unavailable ' +
      'when the series has no two-sided quote.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/option/implied.ts#impliedVol'),
    updateFreq: '1m',
    pit: false,
    derivation: 'Brent solve of BSM(σ) = (PX_BID + PX_ASK)/2',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 27.08, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_MODEL_PX',
    label: 'Model price',
    definition:
      'Option value from the terminal’s own Black-Scholes-Merton valuation at OPT_IMPL_VOL_MID (or ' +
      'the surface value when the series is unquoted), stated per contract unit.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/option/bsm.ts#price'),
    updateFreq: '1m',
    pit: false,
    derivation: 'BSM(S = OPT_UNDL_PX, K, T, r = OPT_RATE_USED, q = OPT_DVD_YIELD_USED, σ)',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 18.39, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_INTRINSIC',
    label: 'Intrinsic value',
    definition:
      'Value the option would have on immediate exercise: max(S − K, 0) for a call, max(K − S, 0) ' +
      'for a put, using OPT_UNDL_PX. Never negative.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/option/value.ts#intrinsic'),
    updateFreq: '1m',
    pit: false,
    derivation: 'max(OPT_UNDL_PX − OPT_STRIKE_PX, 0) for a call; the mirror for a put',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 0, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_TIME_VALUE',
    label: 'Time value',
    definition:
      'The part of the option’s price that is not intrinsic: the mid price less OPT_INTRINSIC. ' +
      'Goes to zero at expiry by construction.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/option/value.ts#timeValue'),
    updateFreq: '1m',
    pit: false,
    derivation: '(PX_BID + PX_ASK)/2 − OPT_INTRINSIC',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 18.42, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_BREAKEVEN',
    label: 'Break-even',
    definition:
      'Underlying price at expiry at which the position returns its premium: strike plus premium ' +
      'for a long call, strike minus premium for a long put.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/option/value.ts#breakeven'),
    updateFreq: '1m',
    pit: false,
    derivation: 'OPT_STRIKE_PX ± mid premium, by put/call',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 368.42, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_RATE_USED',
    label: 'Discount rate used',
    definition:
      'Continuously-compounded risk-free rate the valuation used, interpolated from the Treasury ' +
      'par curve at the option’s time to expiry. Published so that a model price is reproducible.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/curve/interpolate.ts#rateFor'),
    updateFreq: '1m',
    pit: true,
    derivation: 'log-linear interpolation of CURVE_ZERO at T = (OPT_EXPIRE_DT − validAt)/365',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 4.0125, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'OPT_DVD_YIELD_USED',
    label: 'Dividend yield used',
    definition:
      'Continuous dividend yield the valuation assumed for the underlying, from the trailing ' +
      'twelve-month cash dividends over the underlying price. Published for reproducibility.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/option/inputs.ts#dividendYield'),
    updateFreq: '1m',
    pit: true,
    derivation: 'DVD_SH_12M / OPT_UNDL_PX, continuous',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 0.3149, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'OPT_VANNA',
    label: 'Vanna',
    definition:
      'Second-order sensitivity ∂²V/∂S∂σ: how delta moves when implied volatility moves, per ' +
      'volatility point.',
    type: 'number',
    unit: 'ratio',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/option/greeks.ts#vanna'),
    updateFreq: '1m',
    pit: false,
    derivation: '∂²V/∂S∂σ under BSM',
    example: {
      ref: 'AAPL US 12/19/26 C350 Equity',
      value: -0.012844,
      asOf: '2026-09-15T18:41:28Z',
    },
    since: SINCE,
  },
  {
    id: 'OPT_VOLGA',
    label: 'Volga',
    definition:
      'Second-order sensitivity ∂²V/∂σ²: how vega moves when implied volatility moves, per ' +
      'volatility point.',
    type: 'number',
    unit: 'ratio',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/option/greeks.ts#volga'),
    updateFreq: '1m',
    pit: false,
    derivation: '∂²V/∂σ² under BSM',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 0.041207, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_CHARM',
    label: 'Charm',
    definition:
      'Second-order sensitivity ∂²V/∂S∂t: the drift of delta over one calendar day with the ' +
      'underlying unchanged.',
    type: 'number',
    unit: 'ratio',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/option/greeks.ts#charm'),
    updateFreq: '1m',
    pit: false,
    derivation: '∂²V/∂S∂t per calendar day under BSM',
    example: {
      ref: 'AAPL US 12/19/26 C350 Equity',
      value: -0.000412,
      asOf: '2026-09-15T18:41:28Z',
    },
    since: SINCE,
  },

  // ── Statistics (core/analytics/stats) ────────────────────────────────────────────────────────
  {
    id: 'VOL_30D',
    label: 'Realised volatility (30d)',
    definition:
      'Annualised standard deviation of the last 30 daily log returns of the total-return series, ' +
      'in percent, on a 252-day year. Requires at least 25 observations or it is unavailable.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['equity', 'etf', 'index', 'fx', 'crypto'],
    sources: engine('core/analytics/stats/volatility.ts#realised'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'stdev(ln(P_t/P_{t−1}), n = 30) × sqrt(252) × 100',
    example: { ref: 'AAPL US Equity', value: 21.36, asOf: '2026-09-15' },
    since: SINCE,
  },

  // ── Harvested ids kept for coverage (see reference.ts for why) ───────────────────────────────
  {
    id: 'SPREAD',
    label: 'Spread (formula function)',
    definition:
      'Not a field: the formula-language function SPREAD(a, b), which subtracts one security’s ' +
      'series from another’s in a computed watchlist column. A bid-ask spread is PX_ASK − PX_BID.',
    type: 'number',
    unit: null,
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: [],
    updateFreq: 'static',
    pit: false,
    example: { ref: '-', value: 'SPREAD(US10Y, US2Y)', asOf: '2026-09-17' },
    since: SINCE,
    deprecated: { since: SINCE, replacement: null, removeAfter: REMOVE_AFTER },
  },
  {
    id: 'SPREADS',
    label: 'Spreads (BTMM section)',
    definition:
      'Not a field: the SPREADS section token of the BTMM screen, which selects the money-market ' +
      'spread block. Kept only so that the harvested id list resolves.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: [],
    updateFreq: 'static',
    pit: false,
    example: { ref: '-', value: 'BTMM SPREADS', asOf: '2026-09-17' },
    since: SINCE,
    deprecated: { since: SINCE, replacement: null, removeAfter: REMOVE_AFTER },
  },
];
