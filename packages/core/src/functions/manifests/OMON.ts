// packages/core/src/functions/manifests/OMON.ts
//
// `OMON` — Option Monitor (FUNCTIONS_TIER3.md §OMON, FUNCTIONS.md §6).
//
// OMON is a **monitor of the exchange's own marks**, not a pricer. Every implied volatility and
// every greek on this screen is the number Cboe publishes in its delayed chain file
// (`cboe.options`: `iv, delta, gamma, vega, theta, rho, theo`); the resolver re-derives none of
// them. Four values are OMON's own and are labelled as such wherever they appear: `mid`, the two
// put/call ratios, the ATM strike, and the SVI smile fit (`vol.surface@1.0.0`, ANAL-04).
//
// That division is the point of the screen and the reason `PROVIDER_GREEKS_CBOE` is a *constant*
// caveat rather than a conditional one. A reader comparing OMON's delta with OVML's will find them
// different — OVML re-derives on its own conventions — and the payload has to say, without being
// asked, which of the two it is looking at. `OmonLeg.provIdx` therefore points at the
// `cboe.options` capture for every published number, and the fitted smile carries the engine in
// `meta.engines[]` instead.
//
// Deviations from §OMON, recorded here and in the resolver's header:
//
//  * **A null numeric leg cell carries a `meta.unavailable` entry**, one per affected column, with
//    a detail counting the legs. §OMON writes "one-sided or crossed quote on a leg → no
//    `meta.unavailable` row (a one-sided market is a fact, not a gap)". WP-10's runner disagrees
//    and wins: `assertPayloadMeta` rejects any null `ValueCell` under a numeric CSV column id that
//    nothing in `meta.unavailable` explains. The entry is written per *column*, never per leg, so
//    a footer reads "3 of 42 legs carry no Cboe implied volatility" rather than forty-two lines.
//  * **`underlying.iv30Pct` is `IVOL_30D`, not `VOL_30D`.** §OMON's field-id list names `VOL_30D`,
//    which `core/fields/defs/analytic.ts` defines as *realised* 30-day volatility from the close
//    series. The number on this header is the chain file's `iv30` — implied — and `IVOL_30D` is
//    the dictionary id that means that. Publishing implied vol under the realised id would be the
//    kind of mislabelling the dictionary exists to prevent.
//  * **The engine is `vol.surface@1.0.0`**, which is how `core/analytics/vol/surface.ts` registers
//    itself; §0's table writes `vol/surface@1.0.0`. The landed engine's name wins.
//  * **`smile.points` are the windowed strikes, and the fit runs over the chain slice.** The
//    engine inverts and weights its own points from bid/ask, so `svi.n` is the engine's count of
//    quotes it could use, which is at most the number of points OMON plots and is often fewer.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { defineFunction, type CsvColumn, type CsvDocument, type LiveSpec } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§OMON "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const OmonColumns = [
  'bid',
  'ask',
  'mid',
  'last',
  'chg',
  'volume',
  'oi',
  'iv',
  'delta',
  'gamma',
  'vega',
  'theta',
  'rho',
  'theo',
] as const;
export type OmonColumn = (typeof OmonColumns)[number];

export const OmonViews = ['chain', 'smile', 'summary'] as const;
export type OmonView = (typeof OmonViews)[number];

export const OmonSorts = ['strike_asc', 'strike_desc'] as const;
export type OmonSort = (typeof OmonSorts)[number];

export const OMON_DEFAULT_COLUMNS: readonly OmonColumn[] = Object.freeze([
  'theo',
  'delta',
  'iv',
  'oi',
  'volume',
  'chg',
  'last',
  'bid',
  'ask',
]);

export const OmonParams = z.object({
  /** `null` = the nearest listed expiry at or after the valuation date. */
  expiry: z.iso.date().nullable().default(null),
  /** Strikes each side of the centre, inclusive of it. */
  strikes: z.number().int().min(1).max(40).default(10),
  center: z.union([z.literal('atm'), z.number().positive().max(1e6)]).default('atm'),
  /** Percent band around the centre; overrides `strikes` when set. */
  moneyness: z.number().min(1).max(100).nullable().default(null),
  columns: z.array(z.enum(OmonColumns)).min(1).max(14).default([...OMON_DEFAULT_COLUMNS]),
  view: z.enum(OmonViews).default('chain'),
  sort: z.enum(OmonSorts).default('strike_asc'),
});
export type OmonParams = z.infer<typeof OmonParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§OMON "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type OmonCaveat =
  | 'DELAYED_15MIN'
  | 'PROVIDER_GREEKS_CBOE'
  | 'DEEP_ITM_IV_UNRELIABLE'
  | 'NO_OPRA_DEPTH'
  | 'SURFACE_NOT_STORED';

/** The three caveats that are true of every OMON payload this build can produce. */
export const OMON_CONSTANT_CAVEATS: readonly OmonCaveat[] = Object.freeze([
  'DELAYED_15MIN',
  'PROVIDER_GREEKS_CBOE',
  'NO_OPRA_DEPTH',
]);

/** `md_lines.intrinsic_delay_min` for `cboe.options`; stated, never hidden (TERM-12, DATA-03). */
export const OMON_DELAY_MIN = 15;

/** One side of one strike. Every published number is Cboe's; `mid` is OMON's. */
export interface OmonLeg {
  instrumentId: number;
  /** `'AAPL 9/16/26 C245 Equity'`. */
  key: string;
  occSymbol: string;
  /** `'q:80421'`. */
  subject: string;
  bid: ValueCell;
  ask: ValueCell;
  bidSize: ValueCell;
  askSize: ValueCell;
  /** `(bid + ask) / 2` — OMON's, not Cboe's. */
  mid: ValueCell;
  last: ValueCell;
  lastTs: string | null;
  chg: ValueCell;
  chgPct: ValueCell;
  prevClose: ValueCell;
  volume: ValueCell;
  openInterest: ValueCell;
  ivPct: ValueCell;
  delta: ValueCell;
  gamma: ValueCell;
  vega: ValueCell;
  theta: ValueCell;
  rho: ValueCell;
  theo: ValueCell;
  /** `|delta| > 0.99` or `|moneyness| > 25 %` — the `DEEP_ITM_IV_UNRELIABLE` rule. */
  ivSuspect: boolean;
  provIdx: number;
}

export interface OmonUnderlying {
  instrumentId: number;
  key: string;
  name: string;
  px: ValueCell;
  chg: ValueCell;
  chgPct: ValueCell;
  iv30Pct: ValueCell;
  volume: ValueCell;
  subject: string;
  provIdx: number;
  captureTs: string;
}

export interface OmonExpiry {
  expiry: string;
  /** Business days on the `XCBO` calendar, valuation date exclusive. */
  days: number;
  contractCount: number;
  isSelected: boolean;
  isWeekly: boolean;
}

export interface OmonTotals {
  callVolume: ValueCell;
  putVolume: ValueCell;
  callOi: ValueCell;
  putOi: ValueCell;
}

export interface OmonSelected {
  expiry: string;
  /** Expiry 16:00 America/New_York (`am_pm_settlement = 'pm'`). */
  expiryTs: string;
  days: number;
  years: number;
  contractCount: number;
  atmStrike: number | null;
  atmIvPct: ValueCell;
  /** Always `null`: OMON builds no forward (§OMON step 7). */
  forward: ValueCell | null;
  putCallVolumeRatio: ValueCell;
  putCallOiRatio: ValueCell;
  totals: OmonTotals;
}

export interface OmonRow {
  strike: number;
  isAtm: boolean;
  moneynessPct: number;
  call: OmonLeg | null;
  put: OmonLeg | null;
}

export interface OmonSmilePoint {
  strike: number;
  moneynessPct: number;
  callIvPct: number | null;
  putIvPct: number | null;
  oiTotal: number | null;
}

export interface OmonSvi {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
  rmse: number;
  n: number;
}

export type OmonSviUnavailable = 'SURFACE_STORE_NOT_IMPLEMENTED' | 'TOO_FEW_USABLE_QUOTES';

export interface OmonSmile {
  points: OmonSmilePoint[];
  svi: OmonSvi | null;
  sviSource: 'fit' | 'stored' | null;
  sviUnavailableReason: OmonSviUnavailable | null;
}

export interface OmonPayload {
  variant: 'underlying';
  underlying: OmonUnderlying;
  expiries: OmonExpiry[];
  selected: OmonSelected;
  rows: OmonRow[];
  smile: OmonSmile;
  captureTs: string;
  delayMin: 15;
  caveats: OmonCaveat[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§OMON "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const OMON_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_VOLUME',
  'IVOL_30D',
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
  'PX_CLOSE_1D',
  'LAST_TRADE_TIME',
  'OPT_OI',
  'OPT_IV',
  'OPT_DELTA',
  'OPT_GAMMA',
  'OPT_VEGA',
  'OPT_THETA',
  'OPT_RHO',
  'OPT_THEO',
]);

/** The fields a leg's cells follow live (§OMON "Live"). */
export const OMON_LIVE_FIELDS: readonly FieldId[] = Object.freeze([
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
  'CHG_PCT_1D',
  'IVOL_30D',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§OMON "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Wide format, **one row per leg**: calls and puts are separate rows so the column set is
 * rectangular (FUNCTIONS.md §1.6). `params.columns` does not narrow it — the export is the data
 * behind the screen, not the viewport (FUNC-03).
 */
const OMON_COLUMNS: CsvColumn[] = [
  { id: 'expiry', label: 'Expiry', type: 'date' },
  { id: 'strike', label: 'Strike', type: 'number', decimals: 2 },
  { id: 'side', label: 'Side', type: 'string' },
  { id: 'occSymbol', label: 'OCC', type: 'string' },
  { id: 'key', label: 'Security', type: 'string' },
  { id: 'bid', label: 'Bid', type: 'number', decimals: 4 },
  { id: 'bidSize', label: 'Bid size', type: 'number', decimals: 0 },
  { id: 'ask', label: 'Ask', type: 'number', decimals: 4 },
  { id: 'askSize', label: 'Ask size', type: 'number', decimals: 0 },
  { id: 'mid', label: 'Mid', type: 'number', decimals: 4 },
  { id: 'last', label: 'Last', type: 'number', decimals: 4 },
  { id: 'lastTs', label: 'Last time', type: 'datetime' },
  { id: 'chg', label: 'Change', type: 'number', decimals: 4 },
  { id: 'chgPct', label: 'Change %', type: 'number', decimals: 4 },
  { id: 'prevClose', label: 'Prev close', type: 'number', decimals: 4 },
  { id: 'volume', label: 'Volume', type: 'number', decimals: 0 },
  { id: 'openInterest', label: 'Open interest', type: 'number', decimals: 0 },
  { id: 'ivPct', label: 'IV %', type: 'number', decimals: 2 },
  { id: 'delta', label: 'Delta', type: 'number', decimals: 4 },
  { id: 'gamma', label: 'Gamma', type: 'number', decimals: 4 },
  { id: 'vega', label: 'Vega', type: 'number', decimals: 4 },
  { id: 'theta', label: 'Theta', type: 'number', decimals: 4 },
  { id: 'rho', label: 'Rho', type: 'number', decimals: 4 },
  { id: 'theo', label: 'Theo', type: 'number', decimals: 4 },
  { id: 'ivSuspect', label: 'IV suspect', type: 'boolean' },
  { id: 'captureTs', label: 'Captured', type: 'datetime' },
  { id: 'source', label: 'Source', type: 'string' },
];

const numOf = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

/** One CSV row per non-null leg, calls before puts within a strike. */
export function omonCsvRows(payload: OmonPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  for (const row of payload.rows) {
    for (const [side, leg] of [
      ['C', row.call],
      ['P', row.put],
    ] as const) {
      if (leg === null) continue;
      rows.push([
        payload.selected.expiry,
        row.strike,
        side,
        leg.occSymbol,
        leg.key,
        numOf(leg.bid),
        numOf(leg.bidSize),
        numOf(leg.ask),
        numOf(leg.askSize),
        numOf(leg.mid),
        numOf(leg.last),
        leg.lastTs,
        numOf(leg.chg),
        numOf(leg.chgPct),
        numOf(leg.prevClose),
        numOf(leg.volume),
        numOf(leg.openInterest),
        numOf(leg.ivPct),
        numOf(leg.delta),
        numOf(leg.gamma),
        numOf(leg.vega),
        numOf(leg.theta),
        numOf(leg.rho),
        numOf(leg.theo),
        leg.ivSuspect,
        payload.captureTs,
        'cboe.options',
      ]);
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const OMON = defineFunction<typeof OmonParams, OmonPayload>({
  code: 'OMON',
  name: 'Option Monitor',
  aliases: ['CHAIN'],
  tier: 3,
  category: 'derivatives',
  assetClasses: ['equity', 'etf', 'index'],
  requiresSecurity: true,
  variants: { equity: 'underlying', etf: 'underlying', index: 'underlying' },
  params: OmonParams,
  paramGrammar: {
    positional: [{ name: 'expiry', type: 'date', optional: true }],
    keyed: {
      E: { name: 'expiry', type: 'date' },
      N: { name: 'strikes', type: 'number' },
      C: { name: 'center', type: 'number' },
      MNY: { name: 'moneyness', type: 'number' },
      V: { name: 'view', type: 'enum', values: [...OmonViews] },
    },
  },
  fieldIds: (): FieldId[] => [...OMON_FIELD_IDS],
  pageable: true,
  live: (_params, payload): LiveSpec => ({
    subjects: [
      `oc:${String(payload.underlying.instrumentId)}`,
      payload.underlying.subject,
      ...payload.rows.flatMap((r) =>
        [r.call?.subject, r.put?.subject].flatMap((s) => (s === undefined ? [] : [s])),
      ),
    ],
    fields: [...OMON_LIVE_FIELDS],
    conflationMs: 1000,
    essential: [`oc:${String(payload.underlying.instrumentId)}`, payload.underlying.subject],
  }),
  csv: {
    filename: (_params, ctx): string => {
      const key = (ctx.display ?? 'OMON').replace(/[^A-Za-z0-9]+/g, '_');
      return `OMON_${key}_${ctx.asOf.replace(/[-:]/g, '')}.csv`;
    },
    columns: OMON_COLUMNS,
    rows: (payload): CsvDocument['rows'] => omonCsvRows(payload),
  },
  help: {
    summary: 'Listed option chain by expiry with Cboe IV and greeks, ATM highlight and smile',
    description:
      'OMON shows the listed chain for one expiry as the exchange publishes it: calls on the ' +
      'left, puts on the right, strikes down the middle, with Cboe’s own implied volatility and ' +
      'greeks. The expiry tabs and PAGE FWD/PAGE BACK move between expiries; N sets how many ' +
      'strikes either side of the centre are shown and Y switches to a moneyness band. Implied ' +
      'volatilities for deep in- or out-of-the-money contracts are flagged as unreliable because ' +
      'a near-zero vega makes them meaningless. Quotes are exchange-published and fifteen minutes ' +
      'delayed; there is no OPRA feed, so size is Cboe top of book only. Press Enter on any leg ' +
      'to value it in OVML.',
    params: [
      { name: 'expiry', text: 'expiry to show; default the nearest', example: '2026-10-16' },
      { name: 'strikes', text: 'strikes each side of the centre', example: '20' },
      { name: 'center', text: 'centre strike; default the ATM strike', example: '330' },
      { name: 'moneyness', text: 'percent band around the centre, overrides strikes', example: '15' },
      { name: 'columns', text: 'columns to show per leg' },
      { name: 'view', text: 'chain, smile or summary' },
      { name: 'sort', text: 'strike_asc or strike_desc' },
    ],
    keys: [
      { key: 'Enter', action: 'value the focused leg in OVML' },
      { key: 'ArrowLeft / ArrowRight', action: 'previous / next expiry' },
      { key: '1 … 9', action: 'select the n-th listed expiry' },
      { key: 'N', action: 'strikes each side' },
      { key: 'C', action: 'centre strike' },
      { key: 'Y', action: 'moneyness band' },
      { key: 'V', action: 'chain → smile → summary' },
      { key: 'S', action: 'flip the strike sort' },
    ],
    sources: ['cboe.options', 'cboe.quotes', 'internal.derived'],
    related: ['OVML', 'DES', 'Q', 'GP', 'GIP'],
  },
  keymap: [
    { key: 'Enter', action: 'open-ovml', when: 'grid', description: 'Value the focused leg in OVML' },
    {
      key: 'Shift+Enter',
      action: 'open-ovml-next',
      when: 'grid',
      description: 'Value the focused leg in the next panel',
    },
    { key: 'ArrowLeft', action: 'prev-expiry', description: 'Previous expiry' },
    { key: 'ArrowRight', action: 'next-expiry', description: 'Next expiry' },
    { key: '1', action: 'tab-expiry-1', description: 'First listed expiry' },
    { key: '2', action: 'tab-expiry-2', description: 'Second listed expiry' },
    { key: '3', action: 'tab-expiry-3', description: 'Third listed expiry' },
    { key: '4', action: 'tab-expiry-4', description: 'Fourth listed expiry' },
    { key: '5', action: 'tab-expiry-5', description: 'Fifth listed expiry' },
    { key: '6', action: 'tab-expiry-6', description: 'Sixth listed expiry' },
    { key: '7', action: 'tab-expiry-7', description: 'Seventh listed expiry' },
    { key: '8', action: 'tab-expiry-8', description: 'Eighth listed expiry' },
    { key: '9', action: 'tab-expiry-9', description: 'Ninth listed expiry' },
    { key: 'N', action: 'strikes-prompt', description: 'Strikes each side of the centre' },
    { key: 'C', action: 'center-prompt', description: 'Centre strike (blank = ATM)' },
    { key: 'Y', action: 'moneyness-prompt', description: 'Moneyness band %' },
    { key: 'V', action: 'cycle-view', description: 'chain → smile → summary' },
    { key: 'O', action: 'cycle-columns', description: 'Toggle the focused column' },
    { key: 'S', action: 'toggle-sort', description: 'strike_asc ⇄ strike_desc' },
    { key: 'D', action: 'open-des', when: 'grid', description: 'DES of the focused leg' },
    { key: 'U', action: 'open-underlying-des', description: 'DES of the underlying' },
    { key: 'Q', action: 'open-q', when: 'grid', description: 'Q of the focused leg' },
    { key: 'Ctrl+I', action: 'provenance', when: 'grid', description: 'Provenance of the cell' },
    { key: 'Ctrl+W', action: 'add-watchlist', when: 'grid', description: 'Add the leg to a watchlist' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default OMON;
