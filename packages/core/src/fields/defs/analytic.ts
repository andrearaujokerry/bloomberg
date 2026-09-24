// packages/core/src/fields/defs/analytic.ts — field_class 'analytic'
//
// Model output: a number that exists only because an engine computed it from market data plus a
// convention. Every entry carries `derivation` (ANAL-08) naming the engine, and every payload that
// shows one also carries that engine's name/version in `meta.engines`, so a value on the screen can
// always be traced back to the code that produced it.
//
// Provider-published greeks are analytic too (the venue ran the model, not us) — they are marked by
// their source being the option chain rather than `internal.derived`.
//
// ── Return convention (RET_*, VOL_*), reconciled in the code's direction ──────────────────────
//
// These entries used to describe a TOTAL return — dividends reinvested — while the only code that
// computes them, `server/src/functions/shared/returns.ts#periodReturns`, computes a PRICE return on
// split-adjusted closes. Two documents disagreed about what the number on the screen means, which is
// worse than either answer alone, so the conflict is settled here once and in one direction: **the
// dictionary now says what the code does.** RET_1D, RET_1W, RET_1M, RET_YTD, RET_1Y and VOL_30D are
// simple (arithmetic) returns on the `AdjustPolicy 'price'` close series — splits applied, cash
// dividends NOT reinvested, so an ex-dividend date shows as a drop. VOL_90D has no implementation in
// v1; it is declared on the same basis so that whoever writes one has one convention to meet rather
// than a choice to make.
//
// The code was not moved to meet the dictionary because the code is the side the specification
// already agreed with: FUNCTIONS_TIER1 §0.3 defines RET_1W/RET_1M/RET_1Y as `close(t)/close(t₋) − 1`
// and §W defines RET_YTD the same way, and §0.6 pins the engine to
// `{ returns:'simple', priceBasis:'close', adjust:'price', annualisation:252 }` — which
// `PERIOD_RETURNS_CONVENTIONS` freezes and every payload echoes in its footer. Only these
// definitions dissented.
//
// A dividend-reinvested figure is a different quantity, not a correction of this one. The machinery
// for it exists (`AdjustPolicy 'total_return'` in `server/src/data/historical.ts`), so when the
// terminal wants one it gets its own field ids rather than a quiet change of meaning underneath
// these — a number whose definition moves is worse than a number that is missing.

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

/** Asset classes a curve, swap or policy-path number applies to. */
const RATES = ['govt', 'rate'] as const;
/** Asset classes the statistics engine runs a return series for. */
const SERIES = ['equity', 'etf', 'index', 'fx', 'crypto'] as const;

/**
 * A constant-maturity par point of the Treasury curve. Published by `treasury.yieldcurve` as
 * `BC_<tenor>` and reproduced by the terminal's own bootstrap, so both sources are declared.
 */
const crvPoint = (id: string, tenor: string, providerKey: string, value: number): FieldDef => ({
  id,
  label: `Treasury par yield (${tenor})`,
  definition:
    `Constant-maturity par yield of the US Treasury curve at the ${tenor} tenor, in percent — the ` +
    'coupon a par bond of that maturity would carry on the curve build of CURVE_DATE.',
  type: 'number',
  unit: 'pct',
  decimals: 3,
  fieldClass: 'analytic',
  assetClasses: [...RATES],
  sources: [
    src('govt', 'treasury.yieldcurve', 'yieldcurve', `data.dailyTreasuryYieldCurve.${providerKey}`),
    src('govt', 'internal.derived', 'analytics', 'core/analytics/curve/bootstrap.ts#parYield'),
  ],
  updateFreq: 'daily',
  pit: true,
  derivation: `published CMT point, or CURVE_PAR of the active build at t = ${tenor}`,
  example: { ref: 'UST_PAR Curve', value, asOf: '2026-09-15' },
  since: SINCE,
});

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
      'Annualised standard deviation of the last 30 daily simple returns of the split-adjusted ' +
      'close series (adjustment policy `price`), in percent, on a 252-day year. Needs 31 ' +
      'consecutive sessions each carrying a close — a hole in the window makes one “daily” return ' +
      'span two sessions, so the figure is unavailable rather than stretched.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['equity', 'etf', 'index', 'fx', 'crypto'],
    sources: engine('core/analytics/stats/volatility.ts#realised'),
    updateFreq: 'daily',
    pit: false,
    derivation:
      'stdev(P_t/P_{t−1} − 1, n = 30) × sqrt(252) × 100, on the price-adjusted close series ' +
      '(FUNCTIONS_TIER1 §0.6)',
    example: { ref: 'AAPL US Equity', value: 21.36, asOf: '2026-09-15' },
    since: SINCE,
  },

  {
    id: 'VOL_90D',
    label: 'Realised volatility (90d)',
    definition:
      'Annualised standard deviation of the last 90 daily simple returns of the split-adjusted ' +
      'close series (adjustment policy `price`), in percent, on a 252-day year — VOL_30D over the ' +
      'longer window. Requires at least 75 observations or it is unavailable.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#volatility'),
    updateFreq: 'daily',
    pit: false,
    derivation:
      'stdev(P_t/P_{t−1} − 1, n = 90) × sqrt(252) × 100, on the price-adjusted close series ' +
      '(FUNCTIONS_TIER1 §0.6)',
    example: { ref: 'AAPL US Equity', value: 23.71, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'RET_1D',
    label: '1-day return',
    definition:
      'Price return over the last completed session, in percent, on the split-adjusted close ' +
      'series (adjustment policy `price`). Cash dividends are not reinvested, so an ex-dividend ' +
      'date does show as a drop — the dividend-reinvested figure is a separate field.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#simpleReturn'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'close(t) / close(t − 1 session) − 1, ×100, on the price-adjusted series',
    example: { ref: 'AAPL US Equity', value: 0.41, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'RET_1W',
    label: '1-week return',
    definition:
      'Price return over the trailing week, in percent, on the split-adjusted close series. The ' +
      'window is a calendar offset resolved to a session: t₋ is the last session on or before ' +
      't − 7 calendar days, so a holiday-shortened week is still a week.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#simpleReturn'),
    updateFreq: 'daily',
    pit: false,
    derivation:
      'close(t) / close(t₋) − 1, ×100, t₋ = last session ≤ t − 7 calendar days (FUNCTIONS_TIER1 §0.3)',
    example: { ref: 'AAPL US Equity', value: 1.87, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'RET_1M',
    label: '1-month return',
    definition:
      'Price return over the trailing month, in percent, on the split-adjusted close series. t₋ is ' +
      'the last session on or before the same day of the previous month, clamped to that month’s ' +
      'length.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#simpleReturn'),
    updateFreq: 'daily',
    pit: false,
    derivation:
      'close(t) / close(t₋) − 1, ×100, t₋ = last session ≤ t − 1 month (FUNCTIONS_TIER1 §0.3)',
    example: { ref: 'AAPL US Equity', value: 3.42, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'RET_YTD',
    label: 'Year-to-date return',
    definition:
      'Price return from the last session of the previous calendar year to the last completed ' +
      'session, in percent, on the split-adjusted close series.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#simpleReturn'),
    updateFreq: 'daily',
    pit: false,
    derivation:
      'close(t) / close(t₋) − 1, ×100, t₋ = last session of the previous calendar year',
    example: { ref: 'AAPL US Equity', value: 14.62, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'RET_1Y',
    label: '1-year return',
    definition:
      'Price return over the trailing year, in percent, on the split-adjusted close series. t₋ is ' +
      'the last session on or before t − 1 calendar year. Not annualised — it already covers one ' +
      'year.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#simpleReturn'),
    updateFreq: 'daily',
    pit: false,
    derivation:
      'close(t) / close(t₋) − 1, ×100, t₋ = last session ≤ t − 1 year (FUNCTIONS_TIER1 §0.3)',
    example: { ref: 'AAPL US Equity', value: 22.08, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'BETA_1Y',
    label: 'Beta (1 year)',
    definition:
      'OLS slope of the instrument’s daily returns on the benchmark’s daily returns over the ' +
      'trailing 252 sessions — how much the instrument moves for a one-unit move in the benchmark.',
    type: 'number',
    unit: 'ratio',
    decimals: 3,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#beta'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'cov(r_i, r_b) / var(r_b) over 252 sessions, equal to the OLS slope',
    example: { ref: 'AAPL US Equity', value: 1.184, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'CORR_1Y',
    label: 'Correlation to benchmark (1 year)',
    definition:
      'Pearson correlation of the instrument’s daily returns with the benchmark’s over the trailing ' +
      '252 sessions, between −1 and +1.',
    type: 'number',
    unit: 'ratio',
    decimals: 3,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#correlation'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'cov(r_i, r_b) / (stdev(r_i) × stdev(r_b)) over 252 sessions',
    example: { ref: 'AAPL US Equity', value: 0.812, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'SHARPE_1Y',
    label: 'Sharpe ratio (1 year)',
    definition:
      'Annualised excess return over annualised volatility on the trailing window: mean daily ' +
      'simple return less the daily risk-free rate, ×252, divided by the sample (n−1) standard ' +
      'deviation ×√252. The Conventions object that fixes ddof, the 252-day year and the risk-free ' +
      'rate is echoed in the engine output.',
    type: 'number',
    unit: 'ratio',
    decimals: 3,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#sharpe'),
    updateFreq: 'daily',
    pit: false,
    derivation: '(mean(r) × 252 − rf) / (stdev(r, ddof = 1) × sqrt(252))',
    example: { ref: 'TESTING §7.8 stats.vol.sharpe.10', value: 3.495716, asOf: '2026-01-15' },
    since: SINCE,
  },
  {
    id: 'SORTINO_1Y',
    label: 'Sortino ratio (1 year)',
    definition:
      'Annualised excess return over annualised downside deviation — the same numerator as ' +
      'SHARPE_1Y, but the denominator counts only returns below the target, so upside volatility ' +
      'is not penalised.',
    type: 'number',
    unit: 'ratio',
    decimals: 3,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#sortino'),
    updateFreq: 'daily',
    pit: false,
    derivation: '(mean(r) × 252 − rf) / (stdev(min(r − target, 0), ddof = 1) × sqrt(252))',
    example: { ref: 'AAPL US Equity', value: 1.462, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'INFO_RATIO_1Y',
    label: 'Information ratio (1 year)',
    definition:
      'Annualised active return divided by annualised tracking error over the trailing window: ' +
      'return per unit of risk taken away from the benchmark.',
    type: 'number',
    unit: 'ratio',
    decimals: 3,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#informationRatio'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'mean(r_i − r_b) × 252 / (stdev(r_i − r_b, ddof = 1) × sqrt(252))',
    example: { ref: 'AAPL US Equity', value: 0.734, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'MAX_DD_1Y',
    label: 'Maximum drawdown (1 year)',
    definition:
      'Largest peak-to-trough fall of the compounded return series over the trailing window, in ' +
      'percent. Always ≤ 0; 0 means the series never fell below a previous peak.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: [...SERIES],
    sources: engine('core/analytics/stats/index.ts#maxDrawdown'),
    updateFreq: 'daily',
    pit: false,
    derivation: 'min over t of (V_t / max_{s ≤ t} V_s − 1), ×100, on the compounded series',
    example: { ref: 'TESTING §7.8 stats.vol.sharpe.10', value: -1.25, asOf: '2026-01-15' },
    since: SINCE,
  },

  // ── Bond risk, spreads and bill yields (core/analytics/bond/*, bill.ts — ANAL-01, YAS) ────────
  {
    id: 'CONVEXITY_MID',
    label: 'Convexity',
    definition:
      'Second-order price sensitivity in years²: the curvature of the price-yield curve, ' +
      '(1/P) × d²P/dy² with the yield in decimal on the issue’s compounding basis. It is what the ' +
      'first-order DUR_ADJ_MID estimate misses for a large yield move.',
    type: 'number',
    unit: 'years',
    decimals: 3,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/risk.ts#convexity'),
    updateFreq: 'daily',
    pit: true,
    derivation: '(1/PX_DIRTY_MID) × Σ t(t + 1/f) · PV(cf_t) / (1 + y/f)²',
    example: { ref: 'TESTING §7.3 bond.discount.2y', value: 4.484914, asOf: '2026-08-15' },
    since: SINCE,
  },
  {
    id: 'DV01',
    label: 'DV01',
    definition:
      'Dollar value of one basis point: the change in the position’s value, in the instrument ' +
      'currency, for a one basis point parallel fall in yield, on the face amount the analytic was ' +
      'run with. Positive for a long position.',
    type: 'number',
    unit: 'ccy',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['govt', 'rate'],
    sources: engine('core/analytics/bond/risk.ts#dv01'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'DUR_ADJ_MID × PX_DIRTY_MID × face / 100 × 0.0001',
    example: {
      ref: 'TESTING §7.3 bond.discount.2y on 1,000,000 face',
      value: 183.63,
      asOf: '2026-08-15',
    },
    since: SINCE,
  },
  {
    id: 'DV01_PER_100',
    label: 'DV01 per 100 face',
    definition:
      'DV01 expressed in price points per 100 of face, so it is comparable across issues without ' +
      'knowing the face amount. DV01 = DV01_PER_100 × face / 100.',
    type: 'number',
    unit: 'price',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['govt', 'rate'],
    sources: engine('core/analytics/bond/risk.ts#dv01Per100'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'DUR_ADJ_MID × PX_DIRTY_MID × 0.0001',
    example: { ref: 'TESTING §7.3 bond.discount.2y', value: 0.018363, asOf: '2026-08-15' },
    since: SINCE,
  },
  {
    id: 'KRD_2Y',
    label: 'Key-rate duration (2y)',
    definition:
      'Price sensitivity in years to a 1 bp bump of the 2-year node of the pricing curve’s zero ' +
      'curve, with a triangular kernel peaking at 2y and the issue’s z-spread held fixed. The key-' +
      'rate kernels are a partition of unity, so the key-rate durations sum to the curve’s ' +
      'parallel-shift duration, which is DUR_ADJ_MID only approximately — within about 2 % on a ' +
      'Treasury, because a shift of the continuous zero and a derivative in flat-yield space are ' +
      'not the same measurement. A KRD that reproduced DUR_ADJ_MID exactly would be an algebraic ' +
      'slice of it and would carry no curve-twist information.',
    type: 'number',
    unit: 'years',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['govt', 'rate'],
    sources: engine('core/functions/manifests/YAS.ts#bondKrdEngine'),
    updateFreq: 'daily',
    pit: true,
    derivation: '−(P⁺ − P⁻) / (2 × P × 0.0001) for a ±1 bp triangular bump at 2y',
    example: { ref: 'T 4.25 08/15/36 Govt', value: 0.2599, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'KRD_5Y',
    label: 'Key-rate duration (5y)',
    definition:
      'Price sensitivity in years to a 1 bp triangular bump of the 5-year node of the zero curve, ' +
      'the issue’s z-spread held fixed. Small, and possibly negative, for a bond with no cash ' +
      'flow near 5 years: the bumped node still moves the interpolated forwards the bond does ' +
      'discount on, which is exactly the curve information a yield-space decomposition loses.',
    type: 'number',
    unit: 'years',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['govt', 'rate'],
    sources: engine('core/functions/manifests/YAS.ts#bondKrdEngine'),
    updateFreq: 'daily',
    pit: true,
    derivation: '−(P⁺ − P⁻) / (2 × P × 0.0001) for a ±1 bp triangular bump at 5y',
    example: { ref: 'T 4.25 08/15/36 Govt', value: 0.8249, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'KRD_10Y',
    label: 'Key-rate duration (10y)',
    definition:
      'Price sensitivity in years to a 1 bp triangular bump of the 10-year node of the zero curve, ' +
      'the issue’s z-spread held fixed.',
    type: 'number',
    unit: 'years',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['govt', 'rate'],
    sources: engine('core/functions/manifests/YAS.ts#bondKrdEngine'),
    updateFreq: 'daily',
    pit: true,
    derivation: '−(P⁺ − P⁻) / (2 × P × 0.0001) for a ±1 bp triangular bump at 10y',
    example: { ref: 'T 4.25 08/15/36 Govt', value: 7.0956, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'KRD_30Y',
    label: 'Key-rate duration (30y)',
    definition:
      'Price sensitivity in years to a 1 bp bump of the 30-year node of the zero curve, flat beyond ' +
      'the last key tenor, the issue’s z-spread held fixed.',
    type: 'number',
    unit: 'years',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['govt', 'rate'],
    sources: engine('core/functions/manifests/YAS.ts#bondKrdEngine'),
    updateFreq: 'daily',
    pit: true,
    derivation: '−(P⁺ − P⁻) / (2 × P × 0.0001) for a ±1 bp triangular bump at 30y',
    example: { ref: 'T 4.25 08/15/36 Govt', value: -0.012, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'YLD_VAL_32ND',
    label: 'Yield value of 1/32',
    definition:
      'Yield change, in basis points, produced by a price change of one thirty-second of a point — ' +
      'the tick value of the Treasury market expressed in yield terms.',
    type: 'number',
    unit: 'bp',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/risk.ts#yieldValueOf32nd'),
    updateFreq: 'daily',
    pit: true,
    derivation: '(1/32) / DV01_PER_100 × 0.01, in bp',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 0.42, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'ACCRUED_DAYS',
    label: 'Accrued days',
    definition:
      'Number of days of interest accrued from the last coupon date to the settlement date, counted ' +
      'on the issue’s day-count convention — the numerator of the accrual fraction.',
    type: 'integer',
    unit: 'days',
    decimals: 0,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/cashflows.ts#accrualDays'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'dayCount.days(lastCouponDate, settlementDate) on the issue convention',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 31, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'DAY_CNT_FRAC',
    label: 'Day-count fraction',
    definition:
      'Fraction of the current coupon period that has elapsed at settlement on the issue’s day-count ' +
      'convention: ACCRUED_DAYS over the days in the period. ACCRUED is the coupon times this.',
    type: 'number',
    unit: 'ratio',
    decimals: 9,
    fieldClass: 'analytic',
    assetClasses: ['govt', 'rate'],
    sources: engine('core/daycount/conventions.ts#yearFraction'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'ACCRUED_DAYS / days in the coupon period, on the issue convention',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 0.168478261, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'DISC_RATE',
    label: 'Discount rate (bill)',
    definition:
      'Treasury bill discount rate in percent on the ACT/360 bank-discount basis, quoted off the ' +
      'face rather than the price. It is not a return: BEY is the comparable yield.',
    type: 'number',
    unit: 'pct',
    decimals: 3,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: [
      src('govt', 'treasury.bills', 'bills', 'securities[].highDiscountRate'),
      src('govt', 'internal.derived', 'analytics', 'core/analytics/bill.ts#discountFromPrice'),
    ],
    updateFreq: 'daily',
    pit: true,
    derivation: '(100 − price) / 100 × 360 / daysToMaturity × 100',
    example: { ref: '912797VE4 Govt', value: 3.69, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'BEY',
    label: 'Bond-equivalent yield',
    definition:
      'Investment yield of a bill on the ACT/365 coupon-equivalent basis, in percent, so it can be ' +
      'compared with a note’s YLD_YTM_MID. Bills of 182 days or less use the simple formula; longer ' +
      'bills use the quadratic solution that accounts for the intermediate coupon.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bill.ts#beyFromDiscount'),
    updateFreq: 'daily',
    pit: true,
    derivation: '365 d / (360 − d·t) for t ≤ 182 days; the quadratic coupon-equivalent above 182',
    example: { ref: '912797VE4 Govt', value: 3.7603, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'MM_YIELD',
    label: 'Money-market yield',
    definition:
      'Bill yield on the ACT/360 money-market basis, in percent — the discount rate restated as a ' +
      'return on the price paid rather than on the face received.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bill.ts#moneyMarketYield'),
    updateFreq: 'daily',
    pit: true,
    derivation: '360 × d / (360 − d × daysToMaturity)',
    example: { ref: '912797VE4 Govt', value: 3.7096, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'SPRD_TO_CRV',
    label: 'Spread to curve',
    definition:
      'Yield of the security less the pricing curve’s interpolated par yield at the same time to ' +
      'maturity, in basis points. Positive means the security yields more than the curve.',
    type: 'number',
    unit: 'bp',
    decimals: 1,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/risk.ts#spreadToCurve'),
    updateFreq: 'daily',
    pit: true,
    derivation: '(YLD_YTM_MID − CURVE_PAR at the security’s maturity) × 100',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 0, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'SPRD_TO_BENCH',
    label: 'Spread to benchmark',
    definition:
      'Yield of the security less the yield of the on-the-run issue at the nearest standard tenor ' +
      'at or beyond its maturity, in basis points. Unavailable for bills and when the security is ' +
      'itself the benchmark.',
    type: 'number',
    unit: 'bp',
    decimals: 1,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/risk.ts#spreadToBenchmark'),
    updateFreq: 'daily',
    pit: true,
    derivation: '(YLD_YTM_MID − benchmark YLD_YTM_MID) × 100',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 4.2, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'Z_SPRD_MID',
    label: 'Z-spread',
    definition:
      'Constant spread in basis points added to every zero rate of the pricing curve that makes the ' +
      'discounted cash flows equal PX_DIRTY_MID. Unlike SPRD_TO_CRV it uses the whole curve rather ' +
      'than one interpolated point, so it is zero for a bond priced off the curve.',
    type: 'number',
    unit: 'bp',
    decimals: 1,
    fieldClass: 'analytic',
    assetClasses: ['govt'],
    sources: engine('core/analytics/bond/risk.ts#zSpread'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'Brent solve of Σ cf_t · df(t, z) = PX_DIRTY_MID over ±2000 bp',
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 1.3, asOf: '2026-09-15' },
    since: SINCE,
  },

  // ── Curve (core/analytics/curve/*, ANAL-02 — CRVF, ICVS, SWPM, WIRP) ─────────────────────────
  crvPoint('CRV_1M', '1 month', 'BC_1MONTH', 4.021),
  crvPoint('CRV_2M', '2 month', 'BC_2MONTH', 4.008),
  crvPoint('CRV_3M', '3 month', 'BC_3MONTH', 3.987),
  crvPoint('CRV_6M', '6 month', 'BC_6MONTH', 3.921),
  crvPoint('CRV_1Y', '1 year', 'BC_1YEAR', 3.842),
  crvPoint('CRV_2Y', '2 year', 'BC_2YEAR', 3.764),
  crvPoint('CRV_3Y', '3 year', 'BC_3YEAR', 3.748),
  crvPoint('CRV_5Y', '5 year', 'BC_5YEAR', 3.812),
  crvPoint('CRV_7Y', '7 year', 'BC_7YEAR', 3.936),
  crvPoint('CRV_10Y', '10 year', 'BC_10YEAR', 4.073),
  crvPoint('CRV_20Y', '20 year', 'BC_20YEAR', 4.512),
  crvPoint('CRV_30Y', '30 year', 'BC_30YEAR', 4.658),
  {
    id: 'CURVE_PAR',
    label: 'Par rate',
    definition:
      'Par rate of the built curve at the requested time to maturity, in percent: the coupon that ' +
      'prices a bond of that maturity at 100 off the curve’s own discount factors.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: [...RATES],
    sources: engine('core/analytics/curve/curve.ts#parRate'),
    updateFreq: 'daily',
    pit: true,
    derivation: '(1 − CURVE_DF(T)) / Σ accrualFactor_i × CURVE_DF(t_i), ×100',
    example: { ref: 'UST_PAR Curve @ 10y', value: 4.0731, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'CURVE_ZERO',
    label: 'Zero rate',
    definition:
      'Continuously-compounded zero-coupon rate of the built curve at the requested time, in ' +
      'percent — the rate that discounts a single cash flow at that maturity. The curve’s ' +
      'interpolation (linear_zero, log_linear_df or monotone_convex) is echoed with the build.',
    type: 'number',
    unit: 'pct',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: [...RATES],
    sources: engine('core/analytics/curve/curve.ts#zero'),
    updateFreq: 'daily',
    pit: true,
    derivation: '−ln(CURVE_DF(t)) / t × 100',
    example: { ref: 'UST_PAR Curve @ 10y', value: 4.021873, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'CURVE_DF',
    label: 'Discount factor',
    definition:
      'Present value on the built curve of one unit paid at the requested time. Strictly positive ' +
      'and non-increasing in t for an arbitrage-free build; 1.0 at the curve date.',
    type: 'number',
    unit: 'ratio',
    decimals: 9,
    fieldClass: 'analytic',
    assetClasses: [...RATES],
    sources: engine('core/analytics/curve/curve.ts#df'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'exp(−CURVE_ZERO/100 × t) from the bootstrapped nodes',
    example: { ref: 'UST_PAR Curve @ 10y', value: 0.669321044, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'CURVE_FWD_3M',
    label: 'Forward rate (3 month)',
    definition:
      'Three-month forward rate implied by the built curve starting at the requested time, in ' +
      'percent: the rate the curve says will apply over the three months after that date.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: [...RATES],
    sources: engine('core/analytics/curve/curve.ts#fwd'),
    updateFreq: 'daily',
    pit: true,
    derivation: '(CURVE_DF(t1)/CURVE_DF(t2) − 1) / (t2 − t1), ×100 with t2 = t1 + 0.25',
    example: { ref: 'UST_PAR Curve @ 2y', value: 3.7412, asOf: '2026-09-15' },
    since: SINCE,
  },

  // ── SOFR OIS swap (core/analytics/swap/ois.ts — SWPM) ────────────────────────────────────────
  {
    id: 'SWAP_PAR_RATE',
    label: 'Swap par rate',
    definition:
      'Fixed rate in percent that makes the swap’s net present value zero on the SOFR_OIS build: ' +
      'the market rate for the trade’s start, tenor and schedule.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/swap/ois.ts#parRate'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'pvFloat / Σ accrualFactor_i × CURVE_DF(t_i), ×100',
    example: { ref: 'USD SOFR OIS 5Y', value: 3.7412, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'SWAP_FIXED_RATE',
    label: 'Swap fixed rate',
    definition:
      'Fixed rate of the swap as traded, in percent. When the trade is struck at market it equals ' +
      'SWAP_PAR_RATE and SWAP_NPV is zero.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/swap/ois.ts#fixedLeg'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'the trade’s fixed rate, or SWAP_PAR_RATE when none was given',
    example: { ref: 'USD SOFR OIS 5Y', value: 3.75, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'SWAP_NPV',
    label: 'Swap NPV',
    definition:
      'Net present value of the swap in the trade currency from the payer’s side: the PV of the ' +
      'floating leg less the PV of the fixed leg, negated for a receiver. Zero at the par rate.',
    type: 'number',
    unit: 'ccy',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/swap/ois.ts#npv'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'pvFloat − pvFixed for side = pay; negated for receive',
    example: { ref: 'USD SOFR OIS 5Y', value: -4061.42, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'SWAP_PV01',
    label: 'Swap PV01',
    definition:
      'Present value of one basis point on the fixed leg — the annuity of the schedule — in the ' +
      'trade currency. It is the denominator that turns an NPV into a rate difference.',
    type: 'number',
    unit: 'ccy',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/swap/ois.ts#pv01'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'Σ accrualFactor_i × CURVE_DF(t_i) × notional × 0.0001',
    example: { ref: 'USD SOFR OIS 5Y', value: 4612.08, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'SWAP_ACCRUED',
    label: 'Swap accrued',
    definition:
      'Net interest accrued on the current period to the valuation date: fixed-leg accrual less ' +
      'the compounded floating accrual from the published SOFR fixings, in the trade currency.',
    type: 'number',
    unit: 'ccy',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/swap/ois.ts#accrued'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'fixed accrual − compounded float accrual on the current period',
    example: { ref: 'USD SOFR OIS 5Y', value: 1284.31, asOf: '2026-09-15' },
    since: SINCE,
  },

  // ── Volatility surface (core/analytics/vol/surface.ts — ANAL-04, OVML/OMON) ───────────────────
  {
    id: 'IVOL_30D',
    label: 'Implied volatility (30d)',
    definition:
      'At-the-money implied volatility at a constant 30-day horizon, in percent, interpolated in ' +
      'total variance between the two listed expiries that bracket 30 days on the fitted surface.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: ['equity', 'etf', 'index'],
    sources: engine('core/analytics/vol/surface.ts#atmVol'),
    updateFreq: '1m',
    pit: false,
    derivation: 'linear interpolation in σ²T between the bracketing expiries at k = 0, ×100',
    example: { ref: 'AAPL US Equity', value: 26.84, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_FWD_PX',
    label: 'Forward price (chain-implied)',
    definition:
      'Forward price of the underlying for the option’s expiry implied by put-call parity across ' +
      'the chain’s most liquid strikes. It is the abscissa the SVI slice is fitted in, so it is ' +
      'published with the fit.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/vol/surface.ts#forwardFromParity'),
    updateFreq: '1m',
    pit: false,
    derivation: 'K* + (call(K*) − put(K*)) · e^{rT} at the least-absolute-difference strike K*',
    example: { ref: 'AAPL US 12/19/26 Chain', value: 352.18, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_LOG_MNY',
    label: 'Log-moneyness',
    definition:
      'Natural logarithm of strike over OPT_FWD_PX — the x-axis of the SVI slice. Negative below ' +
      'the forward, zero at the money, positive above it.',
    type: 'number',
    unit: 'ratio',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/vol/surface.ts#logMoneyness'),
    updateFreq: '1m',
    pit: false,
    derivation: 'ln(OPT_STRIKE_PX / OPT_FWD_PX)',
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: -0.006209, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'SVI_A',
    label: 'SVI a (level)',
    definition:
      'Vertical-shift parameter of the raw SVI slice w(k) = a + b(ρ(k − m) + √((k − m)² + σ²)): the ' +
      'level of total implied variance for the expiry. Stored as vol_surfaces.svi.a.',
    type: 'number',
    unit: 'ratio',
    decimals: 8,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/vol/surface.ts#fitSlice'),
    updateFreq: '1m',
    pit: false,
    derivation: 'least-squares fit of raw SVI total variance to the slice’s mid implied vols',
    example: { ref: 'AAPL US 12/19/26 Chain', value: 0.01284219, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'SVI_B',
    label: 'SVI b (slope)',
    definition:
      'Wing-slope parameter of the raw SVI slice: half the sum of the left and right asymptotic ' +
      'slopes of total variance in log-moneyness. Non-negative. Stored as vol_surfaces.svi.b.',
    type: 'number',
    unit: 'ratio',
    decimals: 8,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/vol/surface.ts#fitSlice'),
    updateFreq: '1m',
    pit: false,
    derivation: 'least-squares fit of raw SVI total variance to the slice’s mid implied vols',
    example: { ref: 'AAPL US 12/19/26 Chain', value: 0.0921437, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'SVI_RHO',
    label: 'SVI rho (skew)',
    definition:
      'Rotation parameter of the raw SVI slice, in (−1, 1): the skew of the smile. Negative tilts ' +
      'variance towards low strikes, the usual equity shape. Stored as vol_surfaces.svi.rho.',
    type: 'number',
    unit: 'ratio',
    decimals: 8,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/vol/surface.ts#fitSlice'),
    updateFreq: '1m',
    pit: false,
    derivation: 'least-squares fit of raw SVI total variance to the slice’s mid implied vols',
    example: { ref: 'AAPL US 12/19/26 Chain', value: -0.4183625, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'SVI_M',
    label: 'SVI m (shift)',
    definition:
      'Horizontal-shift parameter of the raw SVI slice: the log-moneyness at which the smile is ' +
      'centred. Stored as vol_surfaces.svi.m.',
    type: 'number',
    unit: 'ratio',
    decimals: 8,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/vol/surface.ts#fitSlice'),
    updateFreq: '1m',
    pit: false,
    derivation: 'least-squares fit of raw SVI total variance to the slice’s mid implied vols',
    example: { ref: 'AAPL US 12/19/26 Chain', value: 0.0217483, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'SVI_SIGMA',
    label: 'SVI sigma (curvature)',
    definition:
      'Curvature parameter of the raw SVI slice: how rounded the smile is at its minimum. Strictly ' +
      'positive. Stored as vol_surfaces.svi.sigma — it is not a volatility.',
    type: 'number',
    unit: 'ratio',
    decimals: 8,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/vol/surface.ts#fitSlice'),
    updateFreq: '1m',
    pit: false,
    derivation: 'least-squares fit of raw SVI total variance to the slice’s mid implied vols',
    example: { ref: 'AAPL US 12/19/26 Chain', value: 0.1472066, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'SVI_RMSE',
    label: 'SVI fit RMSE',
    definition:
      'Root-mean-square error of the fitted slice against the observed mid implied volatilities, in ' +
      'volatility points. The quality measure of the fit; stored as vol_surfaces.svi.rmse.',
    type: 'number',
    unit: 'pct',
    decimals: 6,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/vol/surface.ts#fitSlice'),
    updateFreq: '1m',
    pit: false,
    derivation: 'sqrt(mean((σ_fit(k_i) − σ_obs(k_i))²)) over the fitted points, ×100',
    example: { ref: 'AAPL US 12/19/26 Chain', value: 0.184213, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'SVI_N',
    label: 'SVI fit points',
    definition:
      'Number of chain points that entered the SVI fit after the quote, moneyness and ivSuspect ' +
      'filters. Fewer than five points returns no fit. Stored as vol_surfaces.svi.n.',
    type: 'integer',
    unit: 'count',
    decimals: 0,
    fieldClass: 'analytic',
    assetClasses: ['option'],
    sources: engine('core/analytics/vol/surface.ts#fitSlice'),
    updateFreq: '1m',
    pit: false,
    derivation: 'count of strikes surviving the fit filters for the expiry',
    example: { ref: 'AAPL US 12/19/26 Chain', value: 34, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },

  // ── Implied policy path (core/analytics/wirp/policyPath.ts — WIRP) ───────────────────────────
  {
    id: 'WIRP_IMPL_RATE',
    label: 'Implied policy rate',
    definition:
      'Overnight rate in percent that the money-market curve implies will prevail after the FOMC ' +
      'meeting, from the forward rate over the inter-meeting period. Derived from bill and OIS ' +
      'forwards, not from fed funds futures, which this terminal has no source for.',
    type: 'number',
    unit: 'pct',
    decimals: 4,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/wirp/policyPath.ts#impliedRate'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'CURVE_FWD over [meeting, next meeting] on the money-market curve',
    example: { ref: 'FOMC 2026-10-28', value: 3.8712, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'WIRP_MOVE_BP',
    label: 'Implied cumulative move',
    definition:
      'Implied change in the policy rate from the current target midpoint to WIRP_IMPL_RATE, in ' +
      'basis points, cumulative from today to that meeting. Negative means easing.',
    type: 'number',
    unit: 'bp',
    decimals: 1,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/wirp/policyPath.ts#impliedMove'),
    updateFreq: 'daily',
    pit: true,
    derivation: '(WIRP_IMPL_RATE − (TARGET_FROM + TARGET_TO)/2) × 100',
    example: { ref: 'FOMC 2026-10-28', value: -12.9, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'WIRP_PROB_HIKE',
    label: 'Probability of a hike',
    definition:
      'Probability in percent that the meeting moves the target range up by at least one 25 bp ' +
      'step, from the implied move split across the two bracketing 25 bp outcomes. The hold, hike ' +
      'and cut probabilities of one meeting sum to 100.',
    type: 'number',
    unit: 'pct',
    decimals: 1,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/wirp/policyPath.ts#stepProbabilities'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'share of WIRP_MOVE_BP allocated to the +25 bp step and above',
    example: { ref: 'FOMC 2026-10-28', value: 0, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'WIRP_PROB_CUT',
    label: 'Probability of a cut',
    definition:
      'Probability in percent that the meeting moves the target range down by at least one 25 bp ' +
      'step, from the implied move split across the two bracketing 25 bp outcomes.',
    type: 'number',
    unit: 'pct',
    decimals: 1,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/wirp/policyPath.ts#stepProbabilities'),
    updateFreq: 'daily',
    pit: true,
    derivation: 'share of WIRP_MOVE_BP allocated to the −25 bp step and below',
    example: { ref: 'FOMC 2026-10-28', value: 51.6, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'WIRP_PROB_HOLD',
    label: 'Probability of no change',
    definition:
      'Probability in percent that the meeting leaves the target range unchanged: the remainder ' +
      'after WIRP_PROB_HIKE and WIRP_PROB_CUT. A flat curve gives 100.',
    type: 'number',
    unit: 'pct',
    decimals: 1,
    fieldClass: 'analytic',
    assetClasses: ['rate'],
    sources: engine('core/analytics/wirp/policyPath.ts#stepProbabilities'),
    updateFreq: 'daily',
    pit: true,
    derivation: '100 − WIRP_PROB_HIKE − WIRP_PROB_CUT',
    example: { ref: 'FOMC 2026-10-28', value: 48.4, asOf: '2026-09-15' },
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

  // ── WP-06 subject fields (API.md §6.1): oc:<instrumentId> and c:<curveId> ────────────────────
  {
    id: 'EXPIRIES',
    label: 'Expiries',
    definition:
      'Comma-separated ISO dates of every listed expiry in the option chain of the underlying, ' +
      'ascending, on the oc: subject.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/vol/chain.ts#expiries'),
    updateFreq: '1m',
    pit: false,
    derivation: 'sorted distinct expiry dates of the chain',
    example: { ref: 'oc:42', value: '2026-09-18,2026-09-25,2026-10-16', asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'ATM_IV',
    label: 'ATM implied vol',
    definition:
      'At-the-money implied volatility of the nearest listed expiry with at least seven days to ' +
      'expiry, interpolated between the two strikes bracketing the underlying price, in percent.',
    type: 'number',
    unit: 'pct',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/vol/surface.ts#atmVol'),
    updateFreq: '1m',
    pit: false,
    derivation: 'linear interpolation of OPT_IV between the strikes bracketing UNDL_PX at the nearest expiry ≥ 7 d',
    example: { ref: 'oc:42', value: 24.43, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'PUT_CALL_RATIO',
    label: 'Put/call ratio',
    definition: 'Total put volume divided by total call volume across the chain for the current session.',
    type: 'number',
    unit: 'ratio',
    decimals: 2,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/vol/chain.ts#putCallRatio'),
    updateFreq: '1m',
    pit: false,
    derivation: 'Σ put PX_VOLUME / Σ call PX_VOLUME',
    example: { ref: 'oc:42', value: 0.83, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'CONTRACT_COUNT',
    label: 'Contracts',
    definition: 'Number of listed option contracts in the chain of the underlying.',
    type: 'integer',
    unit: 'count',
    decimals: 0,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/vol/chain.ts#contractCount'),
    updateFreq: '1m',
    pit: false,
    derivation: 'count of listed contracts',
    example: { ref: 'oc:42', value: 1864, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'UNDL_PX',
    label: 'Underlying price',
    definition:
      'Price of the underlying the chain summary was computed against, from the same snapshot as ' +
      'the chain so ATM_IV and the underlying never disagree.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/vol/chain.ts#underlyingPrice'),
    updateFreq: '1m',
    pit: false,
    derivation: 'PX_LAST of the underlying at the chain snapshot',
    example: { ref: 'oc:42', value: 330.27, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'TENORS',
    label: 'Tenors',
    definition: 'Comma-separated tenor codes of the curve pillars in order (1M,3M,6M,1Y,2Y,…) on the c: subject.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/curve/build.ts#tenors'),
    updateFreq: '10s',
    pit: false,
    derivation: 'pillar tenors of the curve build',
    example: { ref: 'c:UST_PAR', value: '1M,3M,6M,1Y,2Y,5Y,10Y,30Y', asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'RATES',
    label: 'Rates',
    definition: 'Comma-separated pillar rates in percent, positionally aligned with TENORS.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/curve/build.ts#rates'),
    updateFreq: '10s',
    pit: false,
    derivation: 'CURVE_PAR at each pillar',
    example: { ref: 'c:UST_PAR', value: '4.31,4.28,4.19,4.02,3.88,3.91,4.12,4.63', asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'BUILD_ID',
    label: 'Build id',
    definition: 'Identifier of the curve build the c: subject currently carries (curve_builds.build_id).',
    type: 'integer',
    unit: 'count',
    decimals: 0,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/curve/build.ts#buildId'),
    updateFreq: '10s',
    pit: false,
    derivation: 'curve_builds.build_id',
    example: { ref: 'c:UST_PAR', value: 88213, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'BUILD_TS',
    label: 'Build time',
    definition: 'Time the curve build completed, in UTC.',
    type: 'datetime',
    unit: 'datetime',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/curve/build.ts#buildTs'),
    updateFreq: '10s',
    pit: false,
    derivation: 'curve_builds.built_at',
    example: { ref: 'c:UST_PAR', value: '2026-09-15T18:41:28Z', asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'CURVE_DATE',
    label: 'Curve date',
    definition: 'Valuation date of the curve build: the session whose quotes the pillars were taken from.',
    type: 'date',
    unit: 'date',
    decimals: null,
    fieldClass: 'analytic',
    assetClasses: [],
    sources: engine('core/analytics/curve/build.ts#curveDate'),
    updateFreq: '10s',
    pit: false,
    derivation: 'curve_builds.curve_date',
    example: { ref: 'c:UST_PAR', value: '2026-09-15', asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
];
