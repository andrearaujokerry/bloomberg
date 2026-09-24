// packages/core/src/functions/manifests/OVML.ts
//
// `OVML` — Option Valuation (FUNCTIONS_TIER3.md §OVML, FUNCTIONS.md §6).
//
// One vanilla listed option, valued on the §0 "Option conventions": `T` in years ACT/365F from
// `ctx.asOf.validAt` to the expiry's 16:00 ET settlement instant, `r` the continuously-compounded
// `SOFR_OIS` zero at `T`, `q` the continuously-compounded trailing-twelve-month cash dividend
// yield, premiums per share with `option_terms.multiplier` applied only inside `perContract`.
//
// The two variants differ **only in how the contract is obtained** (FUNC-02): `contract` takes the
// panel security, `underlying` picks the nearest unexpired expiry and the strike closest to spot
// and records that choice in `picked`. Everything after that is one code path, which is why
// `OvmlBody` is a shared interface and the variant is a discriminated wrapper around it.
//
// **Every number in `results` comes out of an `EngineResult`** (ANAL-08). The resolver's own
// arithmetic is limited to unit conversion (decimals ↔ percent, per-share ↔ per-contract) and to
// the difference quotients named below, each of which is a divide over engine outputs rather than
// a second model.
//
// Deviations from §OVML, recorded here and in the resolver's header:
//
//  * **Engine names.** §0's table writes `options/bsm@1.0.0`, `options/tree@1.0.0`,
//    `options/mc@1.0.0`. The landed engines register as `bsm`, `black76`, `option.tree` and
//    `option.mc` (`core/analytics/options/*.ts`), and `meta.engines[]` carries what the engine
//    says its name is.
//  * **Implied volatility is inverted on the European closed form**, for American contracts too.
//    §OVML step 6 says the solver calls the tree pricer for American exercise; `options/bsm`'s
//    `impliedVol` is the only solver the landed analytics expose, and inverting a lattice inside
//    the resolver would be exactly the resolver-side model ANAL-08 forbids. The help text says so
//    in words, and `inputs.volSource` still reports `'solved'`. For a non-dividend-paying
//    underlying the American call equals the European one, so the pinned fixture contract is
//    unaffected; a deep American *put* would imply a slightly high vol, and that is stated rather
//    than hidden.
//  * **Greeks the chosen engine does not return are difference quotients through the same
//    engine.** `bsm`/`black76` return delta, gamma, vega, theta, rho, vanna and volga analytically;
//    the lattices return price, delta, gamma and theta; Monte Carlo returns a price. Everything
//    else is a central difference over extra engine runs — the same shape SWPM's key-rate risk
//    already uses — and every one of those runs is registered in `meta.engines[]`, so a reader can
//    reproduce each bump. `charm` is a difference quotient for every model, because no landed
//    engine returns it.
//  * **`lambda` is `delta × spot / price`**, a unit identity over two engine outputs, not a model.
//  * **The `mc` model does not meet §OVML's 260 ms budget.** The scenario matrix and the greeks
//    profile reprice through the *same* engine, so a 100,000-path simulation runs once per cell.
//    Keeping the profile on a cheaper model would mean publishing a curve the headline number is
//    not on, which is worse than being slow; `paths` is a parameter for the caller who disagrees.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { defineFunction, type CsvColumn, type CsvDocument, type LiveSpec } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§OVML "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const OvmlModels = ['bsm', 'black76', 'crr', 'trinomial', 'mc'] as const;
export type OvmlModel = (typeof OvmlModels)[number];

export const OvmlStyles = ['american', 'european'] as const;
export type OvmlStyle = (typeof OvmlStyles)[number];

export const OvmlViews = ['valuation', 'scenario', 'greeks'] as const;
export type OvmlView = (typeof OvmlViews)[number];

export const OVML_DEFAULT_SPOT_SHOCKS: readonly number[] = Object.freeze([
  -10, -5, -2, 0, 2, 5, 10,
]);
export const OVML_DEFAULT_VOL_SHOCKS: readonly number[] = Object.freeze([-5, 0, 5]);

/** Points on the greeks profile, spanning ±20 % of spot (§OVML step 9). */
export const OVML_PROFILE_POINTS = 21;

export const OvmlParams = z.object({
  /** `null` = `'crr'` for american exercise, `'bsm'` for european. */
  model: z.enum(OvmlModels).nullable().default(null),
  /** `null` = `option_terms.exercise_style`. */
  style: z.enum(OvmlStyles).nullable().default(null),
  /** `underlying` variant: which expiry to pick from. */
  expiry: z.iso.date().nullable().default(null),
  /** `underlying` variant: `null` = the strike nearest spot. */
  strike: z.number().positive().max(1e6).nullable().default(null),
  putCall: z.enum(['C', 'P']).default('C'),
  /** `'vol'` implies from the market mid; `'price'` values at `params.vol`. */
  solveFor: z.enum(['vol', 'price']).default('vol'),
  /** Percent. */
  vol: z.number().min(0.01).max(500).nullable().default(null),
  /** Premium per share to imply a vol from; `null` = the market mid. */
  price: z.number().min(0).max(1e6).nullable().default(null),
  spot: z.number().positive().max(1e7).nullable().default(null),
  /** Percent, continuously compounded. */
  rate: z.number().min(-5).max(50).nullable().default(null),
  /** Percent, continuous. */
  divYield: z.number().min(0).max(50).nullable().default(null),
  /** Black-76 only; `null` = `spot × exp((r − q) × T)`. */
  forward: z.number().positive().max(1e7).nullable().default(null),
  contracts: z.number().int().min(1).max(1_000_000).default(1),
  steps: z.number().int().min(25).max(2000).default(500),
  paths: z.number().int().min(1000).max(1_000_000).default(100_000),
  seed: z.number().int().min(0).max(2 ** 31 - 1).default(42),
  scenarioSpotPct: z
    .array(z.number().min(-90).max(90))
    .min(1)
    .max(13)
    .default([...OVML_DEFAULT_SPOT_SHOCKS]),
  scenarioVolPts: z
    .array(z.number().min(-90).max(90))
    .min(1)
    .max(7)
    .default([...OVML_DEFAULT_VOL_SHOCKS]),
  scenarioDays: z.number().int().min(0).max(365).default(0),
  view: z.enum(OvmlViews).default('valuation'),
});
export type OvmlParams = z.infer<typeof OvmlParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§OVML "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type OvmlCaveat =
  | 'DEEP_ITM_IV_UNRELIABLE'
  | 'IV_NO_CONVERGENCE'
  | 'RATE_FLAT_SOFR'
  | 'PROXY_CURVE'
  | 'NO_FUTURES_SOURCE'
  | 'VANILLA_ONLY_NO_EXOTICS'
  | 'NO_DIVIDEND_HISTORY'
  | 'EXPIRED_CONTRACT';

/** On every payload: v1 has no exotic or path-dependent pricer (ANAL-03 partial). */
export const OVML_VANILLA_ONLY: OvmlCaveat = 'VANILLA_ONLY_NO_EXOTICS';

/** The two the `SOFR_OIS` curve always carries (§0 CRVF table, BRIEF §2). */
export const OVML_PROXY_CURVE_CAVEATS: readonly OvmlCaveat[] = Object.freeze([
  'PROXY_CURVE',
  'NO_FUTURES_SOURCE',
]);

/** REF-04 terms as believed at `ctx.asOf.knownAt`. */
export interface OvmlContract {
  instrumentId: number;
  /** `'AAPL 9/16/26 C245 Equity'`. */
  key: string;
  occSymbol: string;
  root: string;
  underlyingInstrumentId: number;
  expiry: string;
  /** `'2026-09-16T20:00:00.000Z'` — 16:00 ET pm settlement. */
  expiryTs: string;
  strike: number;
  putCall: 'C' | 'P';
  exerciseStyle: OvmlStyle;
  settlement: 'physical' | 'cash';
  amPm: 'am' | 'pm';
  multiplier: number;
  tickSize: number | null;
  isWeekly: boolean;
  lastTradeDate: string | null;
  provIdx: number;
}

export interface OvmlUnderlying {
  instrumentId: number;
  key: string;
  name: string;
  px: ValueCell;
  chgPct: ValueCell;
  iv30: ValueCell;
  provIdx: number;
}

/** The Cboe delayed chain row for this contract (DATA-03, tier `delayed`). */
export interface OvmlMarket {
  bid: ValueCell;
  ask: ValueCell;
  mid: ValueCell;
  last: ValueCell;
  lastTs: string | null;
  prevClose: ValueCell;
  volume: ValueCell;
  openInterest: ValueCell;
  providerIvPct: ValueCell;
  providerDelta: ValueCell;
  providerGamma: ValueCell;
  providerVega: ValueCell;
  providerTheta: ValueCell;
  providerRho: ValueCell;
  providerTheo: ValueCell;
  captureTs: string;
  provIdx: number;
}

export interface OvmlInputs {
  model: OvmlModel;
  style: OvmlStyle;
  spot: ValueCell;
  spotSource: 'market' | 'user';
  volPct: ValueCell;
  volSource: 'solved' | 'provider' | 'user';
  ratePct: ValueCell;
  rateSource: 'SOFR_OIS' | 'SOFR_FIX_FLAT' | 'user';
  rateCurveDate: string | null;
  rateProvIdx: number | null;
  divYieldPct: ValueCell;
  divSource: 'trailing_12m' | 'user' | 'none';
  divProvIdx: number | null;
  forward: ValueCell | null;
  /** `rate − divYield`, in percent. */
  carryB: number;
  years: number;
  days: number;
  valuationTs: string;
  steps: number | null;
  paths: number | null;
  seed: number | null;
}

export interface OvmlPerContract {
  multiplier: number;
  contracts: number;
  premium: ValueCell;
  deltaShares: ValueCell;
  gammaShares: ValueCell;
  /** Per 1 vol point. */
  vegaCcy: ValueCell;
  /** Per calendar day. */
  thetaCcy: ValueCell;
  /** Per 1 % of rate. */
  rhoCcy: ValueCell;
}

export interface OvmlResults {
  price: ValueCell;
  intrinsic: ValueCell;
  timeValue: ValueCell;
  breakeven: ValueCell;
  moneynessPct: ValueCell;
  delta: ValueCell;
  gamma: ValueCell;
  vega: ValueCell;
  theta: ValueCell;
  rho: ValueCell;
  lambda: ValueCell;
  vanna: ValueCell;
  volga: ValueCell;
  charm: ValueCell;
  /** Solved from `params.price ?? market.mid`. */
  impliedVolPct: ValueCell;
  /** `mc` only. */
  mcStdErr: number | null;
  perContract: OvmlPerContract;
}

export interface OvmlScenarioCell {
  spotPct: number;
  volPts: number;
  spot: number;
  volPct: number;
  price: number;
  pnl: number;
  delta: number;
}

export interface OvmlScenario {
  spotPct: number[];
  volPts: number[];
  days: number;
  cells: OvmlScenarioCell[];
}

export interface OvmlProfilePoint {
  spot: number;
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

export interface OvmlBody {
  contract: OvmlContract;
  underlying: OvmlUnderlying;
  market: OvmlMarket;
  inputs: OvmlInputs;
  results: OvmlResults;
  scenario: OvmlScenario;
  /** 21 points over ±20 % of spot, for the greeks chart. */
  greeksProfile: OvmlProfilePoint[];
  /** Echo of `meta.engines` for the footer. */
  engines: { name: string; version: string }[];
  caveats: OvmlCaveat[];
}

export interface OvmlPicked {
  rule: 'nearest_expiry_then_strike_nearest_spot';
  expiry: string;
  strike: number;
  putCall: 'C' | 'P';
  expiriesAvailable: { expiry: string; contractCount: number }[];
  strikesAvailable: number[];
}

export type OvmlPayload =
  | ({ variant: 'contract' } & OvmlBody)
  | ({ variant: 'underlying'; picked: OvmlPicked } & OvmlBody);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§OVML "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The contract's own set. */
export const OVML_CONTRACT_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'OPT_STRIKE_PX',
  'OPT_EXPIRE_DT',
  'OPT_PUT_CALL',
  'OPT_CONT_SIZE',
  'OPT_UNDL_TICKER',
  'OPT_UNDL_PX',
  'PX_BID',
  'PX_ASK',
  'BID_SIZE',
  'ASK_SIZE',
  'PX_LAST',
  'PX_CLOSE_1D',
  'PX_VOLUME',
  'LAST_TRADE_TIME',
  'OPT_OI',
  'OPT_IV',
  'OPT_DELTA',
  'OPT_GAMMA',
  'OPT_VEGA',
  'OPT_THETA',
  'OPT_RHO',
  'OPT_THEO',
  'OPT_MODEL_PX',
  'OPT_IMPL_VOL_MID',
  'OPT_TIME_VALUE',
  'OPT_INTRINSIC',
  'OPT_BREAKEVEN',
  'OPT_VANNA',
  'OPT_VOLGA',
  'OPT_CHARM',
  'OPT_RATE_USED',
  'OPT_DVD_YIELD_USED',
]);

/** The underlying variant adds the underlying's own quote fields. */
export const OVML_UNDERLYING_FIELD_IDS: readonly FieldId[] = Object.freeze([
  ...OVML_CONTRACT_FIELD_IDS,
  'CHG_PCT_1D',
  'IVOL_30D',
]);

export const OVML_LIVE_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_BID',
  'PX_ASK',
  'PX_LAST',
  'PX_VOLUME',
  'LAST_TRADE_TIME',
  'OPT_IV',
  'OPT_DELTA',
  'OPT_GAMMA',
  'OPT_VEGA',
  'OPT_THETA',
  'OPT_RHO',
  'OPT_THEO',
  'OPT_OI',
  'OPT_UNDL_PX',
  'CHG_PCT_1D',
  'IVOL_30D',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§OVML "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Long format (FUNCTIONS.md §1.6 rule 3): one valued object plus two matrices, so every number is
 * a `(section, key)` row. `value` is declared `string` because the column genuinely holds dates,
 * words and numbers; `toCsv` serialises a number in a string column at full stored precision.
 */
const OVML_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'value', label: 'Value', type: 'string' },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'asOf', label: 'As of', type: 'string' },
  { id: 'source', label: 'Source', type: 'string' },
];

const numOf = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

const CBOE = 'cboe.options';
const DERIVED = 'internal.derived';
const USER = 'internal.user';

export function ovmlCsvRows(payload: OvmlPayload, asOf: string): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  const push = (
    section: string,
    key: string,
    value: string | number | boolean | null,
    unit: string,
    source: string,
  ): void => {
    rows.push([section, key, value, unit, asOf, source]);
  };

  const c = payload.contract;
  push('contract', 'key', c.key, 'text', CBOE);
  push('contract', 'occSymbol', c.occSymbol, 'text', CBOE);
  push('contract', 'root', c.root, 'text', CBOE);
  push('contract', 'expiry', c.expiry, 'date', CBOE);
  push('contract', 'expiryTs', c.expiryTs, 'text', DERIVED);
  push('contract', 'strike', c.strike, 'px', CBOE);
  push('contract', 'putCall', c.putCall, 'text', CBOE);
  push('contract', 'exerciseStyle', c.exerciseStyle, 'text', CBOE);
  push('contract', 'settlement', c.settlement, 'text', CBOE);
  push('contract', 'amPm', c.amPm, 'text', CBOE);
  push('contract', 'multiplier', c.multiplier, 'int', CBOE);
  push('contract', 'tickSize', c.tickSize, 'px', CBOE);
  push('contract', 'isWeekly', c.isWeekly, 'text', CBOE);
  push('contract', 'lastTradeDate', c.lastTradeDate, 'date', CBOE);

  const u = payload.underlying;
  push('underlying', 'key', u.key, 'text', DERIVED);
  push('underlying', 'name', u.name, 'text', DERIVED);
  push('underlying', 'px', numOf(u.px), 'px', 'cboe.quotes');
  push('underlying', 'chgPct', numOf(u.chgPct), 'pct', 'cboe.quotes');
  push('underlying', 'iv30', numOf(u.iv30), 'pct', 'cboe.quotes');

  const m = payload.market;
  const market: [string, ValueCell, string][] = [
    ['bid', m.bid, 'px'],
    ['ask', m.ask, 'px'],
    ['mid', m.mid, 'px'],
    ['last', m.last, 'px'],
    ['prevClose', m.prevClose, 'px'],
    ['volume', m.volume, 'int'],
    ['openInterest', m.openInterest, 'int'],
    ['providerIvPct', m.providerIvPct, 'pct'],
    ['providerDelta', m.providerDelta, 'px'],
    ['providerGamma', m.providerGamma, 'px'],
    ['providerVega', m.providerVega, 'px'],
    ['providerTheta', m.providerTheta, 'px'],
    ['providerRho', m.providerRho, 'px'],
    ['providerTheo', m.providerTheo, 'px'],
  ];
  for (const [key, cell, unit] of market) push('market', key, numOf(cell), unit, CBOE);
  push('market', 'lastTs', m.lastTs, 'text', CBOE);
  push('market', 'captureTs', m.captureTs, 'text', CBOE);

  const i = payload.inputs;
  push('inputs', 'model', i.model, 'text', USER);
  push('inputs', 'style', i.style, 'text', USER);
  push('inputs', 'spot', numOf(i.spot), 'px', i.spotSource === 'user' ? USER : 'cboe.quotes');
  push('inputs', 'spotSource', i.spotSource, 'text', DERIVED);
  push('inputs', 'volPct', numOf(i.volPct), 'pct', i.volSource === 'user' ? USER : DERIVED);
  push('inputs', 'volSource', i.volSource, 'text', DERIVED);
  push('inputs', 'ratePct', numOf(i.ratePct), 'pct', i.rateSource === 'user' ? USER : DERIVED);
  push('inputs', 'rateSource', i.rateSource, 'text', DERIVED);
  push('inputs', 'rateCurveDate', i.rateCurveDate, 'date', DERIVED);
  push('inputs', 'divYieldPct', numOf(i.divYieldPct), 'pct', i.divSource === 'user' ? USER : DERIVED);
  push('inputs', 'divSource', i.divSource, 'text', DERIVED);
  push('inputs', 'forward', i.forward === null ? null : numOf(i.forward), 'px', DERIVED);
  push('inputs', 'carryB', i.carryB, 'pct', DERIVED);
  push('inputs', 'years', i.years, 'years', DERIVED);
  push('inputs', 'days', i.days, 'int', DERIVED);
  push('inputs', 'valuationTs', i.valuationTs, 'text', DERIVED);
  push('inputs', 'steps', i.steps, 'int', USER);
  push('inputs', 'paths', i.paths, 'int', USER);
  push('inputs', 'seed', i.seed, 'int', USER);

  const r = payload.results;
  const results: [string, ValueCell, string][] = [
    ['price', r.price, 'px'],
    ['intrinsic', r.intrinsic, 'px'],
    ['timeValue', r.timeValue, 'px'],
    ['breakeven', r.breakeven, 'px'],
    ['moneynessPct', r.moneynessPct, 'pct'],
    ['delta', r.delta, 'px'],
    ['gamma', r.gamma, 'px'],
    ['vega', r.vega, 'px'],
    ['theta', r.theta, 'px'],
    ['rho', r.rho, 'px'],
    ['lambda', r.lambda, 'px'],
    ['vanna', r.vanna, 'px'],
    ['volga', r.volga, 'px'],
    ['charm', r.charm, 'px'],
    ['impliedVolPct', r.impliedVolPct, 'pct'],
  ];
  for (const [key, cell, unit] of results) push('results', key, numOf(cell), unit, DERIVED);
  push('results', 'mcStdErr', r.mcStdErr, 'px', DERIVED);

  const p = r.perContract;
  push('perContract', 'multiplier', p.multiplier, 'int', CBOE);
  push('perContract', 'contracts', p.contracts, 'int', USER);
  for (const [key, cell] of [
    ['premium', p.premium],
    ['deltaShares', p.deltaShares],
    ['gammaShares', p.gammaShares],
    ['vegaCcy', p.vegaCcy],
    ['thetaCcy', p.thetaCcy],
    ['rhoCcy', p.rhoCcy],
  ] as const) {
    push('perContract', key, numOf(cell), 'ccy', DERIVED);
  }

  for (const cell of payload.scenario.cells) {
    const key = `${String(cell.spotPct)}/${String(cell.volPts)}`;
    push('scenario', key, cell.price, 'px', DERIVED);
    push('scenario', `${key}/pnl`, cell.pnl, 'ccy', DERIVED);
  }
  for (const point of payload.greeksProfile) {
    push('profile', String(point.spot), point.price, 'px', DERIVED);
    push('profile', `${String(point.spot)}/delta`, point.delta, 'px', DERIVED);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const OVML = defineFunction<typeof OvmlParams, OvmlPayload>({
  code: 'OVML',
  name: 'Option Valuation',
  aliases: ['OV', 'OPTVAL'],
  tier: 3,
  category: 'derivatives',
  assetClasses: ['option', 'equity', 'etf', 'index'],
  requiresSecurity: true,
  variants: {
    option: 'contract',
    equity: 'underlying',
    etf: 'underlying',
    index: 'underlying',
  },
  params: OvmlParams,
  paramGrammar: {
    positional: [{ name: 'strike', type: 'number', optional: true }],
    keyed: {
      E: { name: 'expiry', type: 'date' },
      K: { name: 'strike', type: 'number' },
      PC: { name: 'putCall', type: 'enum', values: ['C', 'P'] },
      M: { name: 'model', type: 'enum', values: [...OvmlModels] },
      V: { name: 'vol', type: 'number' },
      P: { name: 'price', type: 'number' },
      S: { name: 'spot', type: 'number' },
      R: { name: 'rate', type: 'number' },
      Q: { name: 'divYield', type: 'number' },
      N: { name: 'contracts', type: 'number' },
      ST: { name: 'steps', type: 'number' },
    },
  },
  fieldIds: (assetClass): FieldId[] =>
    assetClass === 'option' ? [...OVML_CONTRACT_FIELD_IDS] : [...OVML_UNDERLYING_FIELD_IDS],
  pageable: false,
  live: (_params, payload): LiveSpec => ({
    subjects: [
      `q:${String(payload.contract.instrumentId)}`,
      `q:${String(payload.underlying.instrumentId)}`,
    ],
    fields: [...OVML_LIVE_FIELDS],
    conflationMs: 1000,
  }),
  csv: {
    filename: (_params, ctx): string => {
      const key = (ctx.display ?? 'OVML').replace(/[^A-Za-z0-9]+/g, '_');
      return `OVML_${key}_${ctx.asOf.replace(/[-:]/g, '')}.csv`;
    },
    columns: OVML_COLUMNS,
    rows: (payload): CsvDocument['rows'] => ovmlCsvRows(payload, payload.inputs.valuationTs),
  },
  help: {
    summary: 'Vanilla option valuation: BSM/Black-76/binomial/trinomial/MC with full greeks',
    description:
      'OVML values one listed option and shows its full greek set. Launched on a contract it ' +
      'values that contract; launched on an equity, ETF or index it picks the nearest expiry and ' +
      'the strike closest to spot. With no inputs it implies volatility from the Cboe mid and ' +
      'reprices at that vol; type a volatility to value at your own number, or a premium to imply ' +
      'a vol from it. The implied volatility is inverted on the European closed form even for an ' +
      'American contract, so a deep American put reads slightly high. The rate is the SOFR OIS ' +
      'zero at the option’s maturity (a proxy curve in this build) and the dividend yield is the ' +
      'trailing twelve months of cash dividends. American contracts default to a 500-step CRR ' +
      'tree; Monte Carlo is seeded and reproducible. The scenario tab reprices a spot × volatility ' +
      'matrix with an optional time decay. Only vanilla payoffs are supported — there is no exotic ' +
      'or path-dependent pricer in v1.',
    params: [
      { name: 'model', text: 'bsm, black76, crr, trinomial or mc', example: 'crr' },
      { name: 'style', text: 'american or european; default from the contract terms' },
      { name: 'expiry', text: 'expiry to pick when launched on the underlying', example: '2026-10-16' },
      { name: 'strike', text: 'strike to pick when launched on the underlying', example: '245' },
      { name: 'putCall', text: 'C or P when launched on the underlying' },
      { name: 'solveFor', text: 'vol implies from the market price, price values at your vol' },
      { name: 'vol', text: 'volatility, percent', example: '28' },
      { name: 'price', text: 'premium per share to imply a vol from', example: '85.42' },
      { name: 'spot', text: 'override the underlying price' },
      { name: 'rate', text: 'continuously-compounded rate, percent' },
      { name: 'divYield', text: 'continuous dividend yield, percent' },
      { name: 'forward', text: 'forward price for Black-76' },
      { name: 'contracts', text: 'number of contracts for the per-contract block', example: '10' },
      { name: 'steps', text: 'tree steps', example: '500' },
      { name: 'paths', text: 'Monte Carlo paths', example: '100000' },
      { name: 'seed', text: 'Monte Carlo seed' },
      { name: 'scenarioSpotPct', text: 'spot shocks, percent' },
      { name: 'scenarioVolPts', text: 'vol shocks, points' },
      { name: 'scenarioDays', text: 'days of decay in the scenario' },
      { name: 'view', text: 'valuation, scenario or greeks' },
    ],
    keys: [
      { key: 'Enter', action: 'reprice from the form' },
      { key: 'M', action: 'cycle the model' },
      { key: 'X', action: 'american ⇄ european' },
      { key: 'I', action: 'reprice at the vol implied by the mid' },
      { key: 'V', action: 'prompt for a volatility' },
      { key: 'K / E / P', action: 'strike, expiry, put/call (underlying variant)' },
      { key: '1 / 2 / 3', action: 'valuation / scenario / greeks' },
      { key: 'O', action: 'open OMON for this expiry' },
    ],
    sources: [
      'cboe.options',
      'cboe.quotes',
      'nyfed.rates',
      'treasury.yieldcurve',
      'internal.derived',
      'internal.user',
    ],
    related: ['OMON', 'DES', 'GP', 'CRVF', 'Q'],
  },
  keymap: [
    { key: 'Enter', action: 'revalue', when: 'form', description: 'Reprice from the form' },
    { key: 'ArrowUp', action: 'bump-field', when: 'form', description: 'One step up on the field' },
    { key: 'ArrowDown', action: 'bump-field', when: 'form', description: 'One step down' },
    { key: 'Shift+ArrowUp', action: 'bump-field-10', when: 'form', description: 'Ten steps up' },
    { key: 'Shift+ArrowDown', action: 'bump-field-10', when: 'form', description: 'Ten steps down' },
    { key: 'M', action: 'cycle-model', description: 'bsm → black76 → crr → trinomial → mc' },
    { key: 'X', action: 'cycle-style', description: 'american ⇄ european' },
    { key: 'I', action: 'solve-iv', description: 'Reprice at the implied vol of the mid' },
    { key: 'V', action: 'vol-prompt', description: 'Volatility %' },
    { key: 'K', action: 'strike-prompt', description: 'Strike (underlying variant)' },
    { key: 'E', action: 'expiry-prompt', description: 'Expiry (underlying variant)' },
    { key: 'P', action: 'toggle-put-call', description: 'C ⇄ P (underlying variant)' },
    { key: '1', action: 'tab-valuation', description: 'Valuation' },
    { key: '2', action: 'tab-scenario', description: 'Scenario' },
    { key: '3', action: 'tab-greeks', description: 'Greeks' },
    { key: 'O', action: 'open-omon', description: 'The chain for this expiry' },
    { key: 'D', action: 'open-des', description: 'Contract description' },
    { key: 'G', action: 'open-gp', description: 'Price chart' },
    {
      key: 'Shift+Enter',
      action: 'open-omon-next',
      when: 'grid',
      description: 'OMON in the next panel',
    },
    { key: 'Ctrl+I', action: 'provenance', description: 'Provenance of the focused cell' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default OVML;
