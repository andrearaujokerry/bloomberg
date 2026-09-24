// packages/core/src/functions/manifests/WIRP.ts
//
// `WIRP` — Implied Policy Path (FUNCTIONS_TIER3.md §WIRP, FUNCTIONS.md §6).
//
// The FOMC-dated overnight path read off the money-market curve, and a two-point allocation of
// each meeting's implied step onto the adjacent 25 bp target ranges.
//
// **This screen does not publish a futures-implied probability distribution, and says so twice.**
// BRIEF §2 is binding: CME FedWatch, fed-funds futures and their options are not reachable, so
// there is no market price of a policy outcome anywhere in this build. What WIRP publishes is
//
//   (a) the implied overnight rate between consecutive FOMC decisions, which is a genuine market
//       observable — the money-market forward over an inter-meeting window *is* the overnight rate
//       the market expects to prevail over it (`core/analytics/wirp/policyPath.ts` header); and
//   (b) a deterministic allocation of each meeting's implied step onto the two bracketing 25 bp
//       target ranges — the same arithmetic FedWatch applies to a futures price, applied here to a
//       curve-implied rate.
//
// {@link WIRP_NO_FUTURES_SOURCE} and {@link WIRP_POINT_MASS_MODEL} are therefore **permanent**
// caveats: they are in `model.caveats` of every payload, in the CSV header comments, and on the
// screen as amber badges. A reader who takes (b) for an options-implied distribution has been
// misled, and that is the one failure this entry is written to prevent.
//
// Three deviations from §WIRP, recorded here and in the task report:
//
//  * **The engine is `wirp.policypath@1.0.0`, not `wirp/policyPath@1.0.0`.** `defineEngine` rejects
//    a name that is not lowercase-dotted (`core/analytics/engine.ts` `ENGINE_NAME_RE`), and the
//    engine landed in WP-02 under the conforming spelling. The landed file wins.
//  * **The live rate subject is `r:<rateCode>`, not `q:<instrumentId>`.** The plant publishes a
//    reference rate under the `r:` family in this build (BTMM's `RateFixingRow.subject`, and
//    §FED's own live spec uses `r:EFFR`). A `q:` subject would need an instrument row that a rate
//    fixing does not have to have.
//  * **A null-by-design cell is `{ v: null, st, provIdx: -1 }` with the reason in
//    `meta.unavailable`**, not `{ …, r: 'NO_SOURCE' }`: `ValueCell.r` is the closed `ReasonCode`
//    union and `NO_SOURCE` is not a member of it. The past-meeting rows do carry
//    `r: 'NOT_IN_UNIVERSE'` and the blanked-target rows `r: 'PROVIDER_DOWN'`, exactly as §WIRP
//    writes them, because both of those *are* members.

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { defineFunction, type CsvColumn, type CsvDocument, type LiveSpec } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§WIRP "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const WirpCurveIds = ['SOFR_OIS', 'UST_BILL'] as const;
export type WirpCurveId = (typeof WirpCurveIds)[number];

export const WirpReferences = ['EFFR', 'SOFR'] as const;
export type WirpReference = (typeof WirpReferences)[number];

export const WirpViews = ['path', 'probabilities'] as const;
export type WirpView = (typeof WirpViews)[number];

export const WirpParams = z.object({
  curveId: z.enum(WirpCurveIds).default('SOFR_OIS'),
  /** `null` = the latest stored `curve_date` ≤ `validAt`. */
  date: z.iso.date().nullable().default(null),
  /** The policy rate the path is expressed in. */
  reference: z.enum(WirpReferences).default('EFFR'),
  /** `null` = derive `reference − SOFR` from the stored fixings. */
  basisBp: z.number().min(-100).max(100).nullable().default(null),
  meetings: z.number().int().min(1).max(8).default(8),
  stepBp: z.number().int().min(5).max(50).default(25),
  /** An earlier curve date to show the path shift against. */
  compare: z.iso.date().nullable().default(null),
  view: z.enum(WirpViews).default('path'),
});
export type WirpParams = z.infer<typeof WirpParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Caveats
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Permanent: there is no fed-funds futures or options source in the reachable set (BRIEF §2). */
export const WIRP_NO_FUTURES_SOURCE = 'NO_FUTURES_SOURCE';
/** Permanent: the probability block is an allocation of a rate, not a traded distribution. */
export const WIRP_POINT_MASS_MODEL = 'POINT_MASS_PROBABILITY_MODEL';
/** The `SOFR_OIS` term points are proxied (CRVF table row `SOFR_OIS`). */
export const WIRP_PROXY_CURVE = 'PROXY_CURVE';
export const WIRP_NO_OIS_QUOTES = 'NO_OIS_SWAP_QUOTES_SOURCE';
/** Fewer undecided meetings are published than the caller asked to project. */
export const WIRP_CALENDAR_HORIZON = 'FOMC_CALENDAR_HORIZON';

export type WirpCurveCaveat = typeof WIRP_PROXY_CURVE | typeof WIRP_NO_OIS_QUOTES;
export type WirpModelCaveat =
  | typeof WIRP_NO_FUTURES_SOURCE
  | typeof WIRP_POINT_MASS_MODEL
  | WirpCurveCaveat
  | typeof WIRP_CALENDAR_HORIZON;

/** The two `#` comment lines every WIRP export carries, first, in this order (API.md §9). */
export const WIRP_CSV_NOTES: readonly string[] = Object.freeze([
  'implied allocation, not an options-implied distribution',
  'no fed-funds futures or options source (BRIEF §2)',
]);

/** The one sentence the probabilities tab must render above the grid. */
export const WIRP_PROBABILITY_DISCLAIMER =
  'Implied allocation of the curve-implied step onto adjacent 25 bp ranges — not an ' +
  'options-implied distribution; no fed-funds futures source';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§WIRP "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface WirpCurrent {
  rateCode: WirpReference;
  effectiveDate: string;
  rate: ValueCell;
  targetFrom: ValueCell;
  targetTo: ValueCell;
  targetMid: ValueCell;
  provIdx: number;
}

export interface WirpBasis {
  appliedBp: ValueCell;
  source: 'derived' | 'user' | 'zero';
  observations: number;
  window: { from: string; to: string } | null;
  formula: 'mean(EFFR − SOFR) over stored fixings';
}

/**
 * The curve the path was read off.
 *
 * **Widening of §WIRP**, which types `date`, `method`, `interpolation` and `sourceId` as
 * non-nullable: `data.curves.points` throws when a curve has nothing stored on or before the
 * as-of date, and a policy page that 500s because last night's ingest has not run is worse than
 * one that says the curve is missing. `null` is that statement, and it travels with a `NO_SOURCE`
 * entry in `meta.unavailable`. `BtmmCurveBlock.curveDate` records the same widening.
 */
export interface WirpCurveBlock {
  id: WirpCurveId;
  date: string | null;
  requestedDate: string | null;
  buildId: number | null;
  method: 'bills+par_bootstrap' | 'ois_bootstrap' | null;
  interpolation: string | null;
  sourceId: string | null;
  provIdx: number;
  caveats: WirpCurveCaveat[];
}

/** One 25 bp outcome of one meeting, and the share the implied step allocates to it. */
export interface WirpOutcome {
  /** Whole steps from the current target: `-1` is one cut, `+1` one hike. */
  moves: number;
  /** `moves × stepBp`. */
  bp: number;
  rangeFrom: number;
  rangeTo: number;
  probPct: ValueCell;
}

export interface WirpVsCompare {
  date: string;
  cumChangeBp: number | null;
  deltaBp: number | null;
}

export interface WirpMeeting {
  meetingDate: string;
  statementAt: string | null;
  hasSep: boolean;
  isPast: boolean;
  daysAhead: number;
  /** ACT/365F years from the valuation date to the meeting date. */
  t: number;
  impliedOvernightPct: ValueCell;
  impliedReferencePct: ValueCell;
  cumChangeBp: ValueCell;
  stepChangeBp: ValueCell;
  impliedMoves: ValueCell;
  outcomes: WirpOutcome[];
  vsCompare: WirpVsCompare | null;
  /** `fomc_meetings.decision_bp` — non-null only when `isPast`. Never a model number. */
  decisionBp: number | null;
  provIdx: number;
}

export interface WirpTerminal {
  meetingDate: string | null;
  ratePct: ValueCell;
  cumChangeBp: ValueCell;
}

export interface WirpModel {
  /** `null` when no path was computed — there is no curve, or no undecided meeting to project. */
  engine: { name: string; version: string; inputsHash: string } | null;
  stepBp: number;
  probabilityModel: 'two_point_interpolation';
  caveats: WirpModelCaveat[];
}

export interface WirpPayload {
  variant: 'default';
  /** Valuation date, America/New_York. */
  asOfDate: string;
  current: WirpCurrent;
  basis: WirpBasis;
  curve: WirpCurveBlock;
  meetings: WirpMeeting[];
  terminal: WirpTerminal;
  model: WirpModel;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§WIRP "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The entitlement pre-check set: the NY Fed fixing fields.
 *
 * The curve ids (`CRV_*`, `CURVE_*`) are deliberately **not** pre-checked, for the reason BTMM.ts
 * records at length: `EntitlementDecision.effectiveTier` is the minimum over the fields asked
 * about, and pre-checking an `eod`-capped published curve would seed the plant gate for the whole
 * run with `TIER_EOD` — for cells that are stored values the plant gate never touches. The full
 * §WIRP list is {@link WIRP_FIELD_IDS} and is what the screen subscribes to.
 */
export const WIRP_PRECHECK_FIELDS: readonly FieldId[] = Object.freeze([
  'RATE',
  'TARGET_FROM',
  'TARGET_TO',
  'RATE_VOLUME_BN',
  'RATE_AVG_30D',
]);

export const WIRP_FIELD_IDS: readonly FieldId[] = Object.freeze([
  ...WIRP_PRECHECK_FIELDS,
  'CRV_1M',
  'CRV_3M',
  'CRV_6M',
  'CRV_1Y',
  'CRV_2Y',
  'CURVE_ZERO',
  'CURVE_DF',
  'CURVE_FWD_3M',
]);

/** What the live subscription asks for (§WIRP "Live"). */
export const WIRP_LIVE_FIELDS: readonly FieldId[] = Object.freeze([
  'RATE',
  'TARGET_FROM',
  'TARGET_TO',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§WIRP "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const WIRP_COLUMNS: CsvColumn[] = [
  { id: 'meetingDate', label: 'Meeting', type: 'date' },
  { id: 'hasSep', label: 'SEP', type: 'boolean' },
  { id: 'isPast', label: 'Past', type: 'boolean' },
  { id: 'daysAhead', label: 'Days ahead', type: 'number' },
  { id: 'impliedOvernightPct', label: 'Implied O/N %', type: 'number', decimals: 4 },
  { id: 'impliedReferencePct', label: 'Implied reference %', type: 'number', decimals: 4 },
  { id: 'cumChangeBp', label: 'Cumulative bp', type: 'number', decimals: 2 },
  { id: 'stepChangeBp', label: 'Step bp', type: 'number', decimals: 2 },
  { id: 'impliedMoves', label: 'Implied moves', type: 'number', decimals: 3 },
  { id: 'outcomeMoves', label: 'Outcome moves', type: 'number' },
  { id: 'outcomeBp', label: 'Outcome bp', type: 'number' },
  { id: 'rangeFrom', label: 'Range from', type: 'number', decimals: 4 },
  { id: 'rangeTo', label: 'Range to', type: 'number', decimals: 4 },
  { id: 'probPct', label: 'Probability %', type: 'number', decimals: 2 },
  { id: 'vsCompareDeltaBp', label: 'Vs compare bp', type: 'number', decimals: 2 },
  { id: 'decisionBp', label: 'Decision bp', type: 'number' },
  { id: 'source', label: 'Source', type: 'string' },
];

const numOf = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

/**
 * One row per (`meetings[]` × `outcomes[]`); a past meeting emits a single row with the implied
 * and outcome columns empty and `decisionBp` filled.
 */
export function wirpCsvRows(payload: WirpPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  for (const m of payload.meetings) {
    const head = [
      m.meetingDate,
      m.hasSep,
      m.isPast,
      m.daysAhead,
      numOf(m.impliedOvernightPct),
      numOf(m.impliedReferencePct),
      numOf(m.cumChangeBp),
      numOf(m.stepChangeBp),
      numOf(m.impliedMoves),
    ];
    const tail = [m.vsCompare?.deltaBp ?? null, m.decisionBp, 'internal.derived'];
    if (m.outcomes.length === 0) {
      rows.push([...head, null, null, null, null, null, ...tail]);
      continue;
    }
    for (const o of m.outcomes) {
      rows.push([
        ...head,
        o.moves,
        o.bp,
        o.rangeFrom,
        o.rangeTo,
        numOf(o.probPct),
        ...tail,
      ]);
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const WIRP = defineFunction<typeof WirpParams, WirpPayload>({
  code: 'WIRP',
  name: 'Implied Policy Path',
  aliases: ['FFIP', 'PATH'],
  tier: 3,
  category: 'rates',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: WirpParams,
  paramGrammar: {
    positional: [
      { name: 'curveId', type: 'curve', optional: true, values: [...WirpCurveIds] },
      { name: 'date', type: 'date', optional: true },
    ],
    keyed: {
      REF: { name: 'reference', type: 'enum', values: [...WirpReferences] },
      BASIS: { name: 'basisBp', type: 'number' },
      N: { name: 'meetings', type: 'number' },
      STEP: { name: 'stepBp', type: 'number' },
      CMP: { name: 'compare', type: 'date' },
      V: { name: 'view', type: 'enum', values: [...WirpViews] },
    },
  },
  fieldIds: (): FieldId[] => [...WIRP_PRECHECK_FIELDS],
  pageable: false,
  live: (params, payload): LiveSpec => ({
    subjects: [`c:${params.curveId}`, `r:${payload.current.rateCode}`],
    fields: [...WIRP_LIVE_FIELDS],
    conflationMs: 1000,
  }),
  csv: {
    // §WIRP names the *served* curve date here; `filename` is given the params and the as-of, not
    // the payload, so a typed `date` is used when there is one and the as-of day otherwise.
    filename: (params, ctx): string =>
      `WIRP_${params.reference}_${(params.date ?? ctx.asOf.slice(0, 10)).replace(/-/g, '')}.csv`,
    columns: WIRP_COLUMNS,
    rows: (payload): CsvDocument['rows'] => wirpCsvRows(payload),
  },
  help: {
    summary: 'FOMC-dated implied policy path from the money-market curve (no futures source)',
    description:
      'WIRP reads the overnight rate implied between consecutive FOMC decision dates off the SOFR ' +
      'OIS curve (or the Treasury bill curve) and expresses it as an EFFR path against the ' +
      'current target midpoint: the implied rate at each meeting, the cumulative and per-meeting ' +
      'change in basis points, and the implied number of 25 bp moves. Because no fed-funds ' +
      'futures or options source is reachable, the probability tab is not an options-implied ' +
      'distribution: it allocates each meeting’s implied step onto the two adjacent 25 bp target ' +
      'ranges by linear interpolation, and says so on screen and in the export. The EFFR−SOFR ' +
      'basis is derived from the stored fixings and can be overridden. Compare a second curve ' +
      'date to see how the path shifted.',
    params: [
      { name: 'curveId', text: 'SOFR_OIS or UST_BILL', example: 'SOFR_OIS' },
      { name: 'date', text: 'curve date; default latest', example: '2026-09-14' },
      { name: 'reference', text: 'EFFR or SOFR', example: 'REF=SOFR' },
      {
        name: 'basisBp',
        text: 'EFFR−SOFR basis in bp; default derived from fixings',
        example: 'BASIS=1',
      },
      { name: 'meetings', text: 'how many undecided meetings to project', example: 'N=8' },
      { name: 'stepBp', text: 'assumed policy increment', example: 'STEP=25' },
      { name: 'compare', text: 'earlier curve date to diff the path against', example: '2026-09-08' },
      { name: 'view', text: 'path or probabilities', example: 'V=PROBABILITIES' },
    ],
    keys: [
      { key: '1 / 2', action: 'path / probabilities tab' },
      { key: 'K', action: 'cycle SOFR_OIS / UST_BILL' },
      { key: 'D', action: 'pick the curve date' },
      { key: 'R', action: 'cycle EFFR / SOFR' },
      { key: 'B', action: 'override the basis' },
      { key: 'S', action: 'override the policy step' },
      { key: 'N', action: 'cycle 3 / 4 / 6 / 8 meetings' },
      { key: 'C', action: 'compare a second curve date' },
    ],
    sources: [
      'nyfed.rates',
      'fed.fomc',
      'treasury.yieldcurve',
      'treasury.bills',
      'internal.derived',
    ],
    related: ['FED', 'CRVF', 'ICVS', 'BTMM', 'ECO'],
  },
  keymap: [
    { key: '1', action: 'tab-path', description: 'The implied path' },
    { key: '2', action: 'tab-probabilities', description: 'The implied allocation' },
    { key: 'K', action: 'cycle-curve', description: 'SOFR_OIS → UST_BILL' },
    { key: 'D', action: 'date-prompt', description: 'Curve date' },
    {
      key: 'ArrowLeft',
      action: 'prev-date',
      when: 'grid',
      description: 'Step back through the stored curve dates',
    },
    {
      key: 'ArrowRight',
      action: 'next-date',
      when: 'grid',
      description: 'Step forward through the stored curve dates',
    },
    { key: 'R', action: 'cycle-reference', description: 'EFFR → SOFR' },
    { key: 'B', action: 'basis-prompt', description: 'EFFR−SOFR basis, bp' },
    { key: 'S', action: 'step-prompt', description: 'Policy step, bp' },
    { key: 'N', action: 'cycle-meetings', description: '3 → 4 → 6 → 8' },
    { key: 'C', action: 'compare-prompt', description: 'Compare curve date' },
    { key: 'X', action: 'clear-compare', description: 'Clear the comparison' },
    {
      key: 'Enter',
      action: 'row-provenance',
      when: 'grid',
      description: 'Provenance of the focused meeting',
    },
    {
      key: 'Shift+Enter',
      action: 'open-fed-next',
      when: 'grid',
      description: 'FED for the focused meeting in the next panel',
    },
    { key: 'G', action: 'open-crvf', description: 'The curve behind the path' },
    { key: 'I', action: 'open-icvs', description: 'Compare the curve with UST_PAR' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default WIRP;
