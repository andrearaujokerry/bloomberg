// packages/core/src/functions/manifests/CACS.ts
//
// `CACS` — Corporate Actions (FUNCTIONS_TIER2.md §CACS L810-997, FUNCTIONS.md §6 L1095).
//
// `issuer` (equity, etf) is the timeline of every `corporate_actions` row for the instrument in the
// window — cash and special dividends, splits, name and ticker changes — each row carrying its
// place on the estimated → announced → confirmed → paid ladder (DATA-08) and the price-adjustment
// factor it contributes (REF-09), with the 8-K item 2.02 earnings dates on the same timeline.
// `members` (index) is the forward calendar of the constituents' ex-dates, weighted, so a PM can
// see the index's dividend drag.
//
// ## The ladder is reported, never completed
//
// The reachable event feed publishes an action only *after* its ex-date, so the `estimated` and
// `announced` rungs of DATA-08's ladder exist for real only when data operations entered them by
// hand (`internal.user`). CACS says so, every run, through `ESTIMATED_CA_UNAVAILABLE` — and the
// one forward-looking row it produces itself is badged `projected: true` with the cadence it was
// derived from in `projectionBasis`. It is never written to `corporate_actions` and never claims a
// status other than `estimated`. Seven of the fifteen `ca_type` values have no reachable source at
// all; each is reported as unavailable with a reason rather than rendered as an empty section.

import { z } from 'zod';

import type { CaStatus, CaType } from '../../adjust/corporateActions.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import type { FieldId } from '../../types/fields.js';
import type { AssetClass } from '../../types/instrument.js';
import type { ValueCell } from '../../types/function.js';
import { getField } from '../../fields/dictionary.js';

export type { CaStatus, CaType };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§CACS "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CA_TYPES = [
  'cash_dividend',
  'special_dividend',
  'stock_dividend',
  'split',
  'reverse_split',
  'spinoff',
  'merger',
  'tender',
  'rights',
  'call',
  'conversion',
  'name_change',
  'ticker_change',
  'delisting',
  'capital_return',
] as const;

export const CA_STATUSES = ['estimated', 'announced', 'confirmed', 'paid', 'cancelled'] as const;

export const CACS_DEFAULT_TYPES: readonly CaType[] = Object.freeze([
  'cash_dividend',
  'special_dividend',
  'stock_dividend',
  'split',
  'reverse_split',
  'name_change',
  'ticker_change',
] as CaType[]);

export const CACS_DEFAULT_STATUS: readonly CaStatus[] = Object.freeze([
  'announced',
  'confirmed',
  'paid',
] as CaStatus[]);

/** The seven `ca_type` values no reachable source publishes in this build (BRIEF §2). */
export const CACS_UNSOURCED_TYPES: readonly CaType[] = Object.freeze([
  'spinoff',
  'merger',
  'tender',
  'rights',
  'call',
  'conversion',
  'delisting',
  'capital_return',
] as CaType[]);

export const CacsParams = z.object({
  /** Default: `validAt − 2 years` (issuer) / `validAt − 7 days` (members). */
  from: z.iso.date().optional(),
  /** Default: `validAt + 90 days`. */
  to: z.iso.date().optional(),
  types: z.array(z.enum(CA_TYPES)).default([...CACS_DEFAULT_TYPES]),
  status: z.array(z.enum(CA_STATUSES)).default([...CACS_DEFAULT_STATUS]),
  /** issuer: the 8-K item 2.02 dates on the same timeline. */
  includeEarnings: z.boolean().default(true),
  /** The resolver-derived next ex-date; always status `estimated`. */
  includeProjected: z.boolean().default(true),
  /** index variant only. */
  members: z.number().int().min(5).max(100).default(50),
  /** PIT override (STOR-06, REF-03); undefined = `ctx.asOf.knownAt`. */
  knownAt: z.iso.datetime().optional(),
});
export type CacsParams = z.infer<typeof CacsParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§CACS "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type CaReviewState = 'auto' | 'queued' | 'reviewed' | 'rejected';

/** One row of the timeline. Field names mirror API.md §5.1 `CorporateAction`, plus four extras. */
export interface CacsAction {
  /** `null` on a projected row — never written to `corporate_actions`. */
  caId: number | null;
  instrumentId: number;
  key: string;
  caType: CaType;
  status: CaStatus;
  declaredDate: string | null;
  exDate: string;
  recordDate: string | null;
  payDate: string | null;
  effectiveDate: string | null;
  amount: number | null;
  currency: string | null;
  ratioNew: number | null;
  ratioOld: number | null;
  newInstrumentId: number | null;
  newKey: string | null;
  frequency: string | null;
  grossOrNet: 'gross' | 'net';
  details: Record<string, unknown>;
  note: string | null;
  /** `'yahoo.chart' | 'sec.submissions' | 'internal.user' | 'internal.derived'`. */
  sourceId: string;
  /** REF-10 dual key. */
  reviewState: CaReviewState;
  /** The `core/adjust/corporateActions.ts` price factor this row contributes. */
  adjFactor: number | null;
  projected: boolean;
  /** `'median gap of last 8 cash dividends = 91 d'`. */
  projectionBasis: string | null;
  provIdx: number;
}

export interface CacsEarnings {
  accessionNo: string;
  form: string;
  filedAt: string;
  acceptedAt: string;
  reportDate: string | null;
  items8k: string[];
  reportTiming: 'pre' | 'post' | 'intraday' | 'unknown';
  url: string;
  provIdx: number;
}

export interface CacsProjection {
  exDate: string;
  amount: number | null;
  basis: string;
  confidence: number;
}

export interface CacsIssuerPayload {
  variant: 'issuer';
  security: { instrumentId: number; key: string; name: string; currency: string };
  issuer: { issuerId: number | null; name: string; cik: string | null };
  window: { from: string; to: string };
  knownAt: string;
  /** Future block first (ex-date ascending), then the past block (ex-date descending). */
  actions: CacsAction[];
  earnings: CacsEarnings[];
  summary: {
    ttmCashDividend: number | null;
    ttmCount: number;
    frequency: string | null;
    dvdYield: ValueCell;
    pxLast: ValueCell;
    lastSplit: { exDate: string; ratioNew: number; ratioOld: number } | null;
    nextProjected: CacsProjection | null;
    /** Product of `adjFactor` over the window's rows with `exDate ≤ validAt` (REF-09). */
    cumulativeAdjFactor: number;
  };
  counts: Partial<Record<CaType, number>>;
  notes: string[];
}

export type CacsMemberAction = CacsAction & {
  weight: number | null;
  /** `amount × weight`; `null` when either is null. */
  weightedAmount: number | null;
};

export interface CacsMembersPayload {
  variant: 'members';
  index: { instrumentId: number; key: string; name: string; indexId: number };
  membership: {
    asOfDate: string;
    sourceId: string;
    shown: number;
    total: number;
    provIdx: number;
  };
  window: { from: string; to: string };
  knownAt: string;
  actions: CacsMemberAction[];
  summary: {
    exDateCount: number;
    weightedCashPerIndexUnit: number | null;
    /** Members with ≥ 1 known action ÷ shown. */
    coverage: number;
  };
  notes: string[];
}

export type CacsPayload = CacsIssuerPayload | CacsMembersPayload;

export const CACS_NOTE_ESTIMATED_UNAVAILABLE = 'ESTIMATED_CA_UNAVAILABLE';
export const CACS_NOTE_TYPES_NO_SOURCE = 'CA_TYPES_NO_SOURCE';
export const CACS_NOTE_PROJECTED_ROW = 'PROJECTED_ROW';
export const CACS_NOTE_PROJECTION_INSUFFICIENT = 'PROJECTION_INSUFFICIENT_HISTORY';
export const CACS_NOTE_REVIEW_PENDING = 'CA_REVIEW_PENDING';
export const CACS_NOTE_ADJ_NO_CLOSE = 'ADJ_FACTOR_NO_CLOSE';
export const CACS_NOTE_MEMBER_SUBSET = 'MEMBER_SUBSET';
export const CACS_NOTE_MEMBERSHIP_STALE = 'MEMBERSHIP_STALE';
export const CACS_NOTE_COVERAGE_PARTIAL = 'COVERAGE_PARTIAL';
export const CACS_NOTE_EARNINGS_NOT_APPLICABLE = 'EARNINGS_NOT_APPLICABLE_INDEX';

/** §CACS step 8: fewer than this many cash dividends and no projection is attempted. */
export const CACS_PROJECTION_MIN_ROWS = 4;
/** At or above this many, the projection's stated confidence rises from 0.4 to 0.6. */
export const CACS_PROJECTION_HIGH_CONFIDENCE_ROWS = 8;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§CACS "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `issuer`: long format — three blocks under one `section` column (§1.6 rule 3). */
export const cacsIssuerCsvColumns: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'exDate', label: 'Ex-date', type: 'date' },
  { id: 'caType', label: 'Type', type: 'string' },
  { id: 'status', label: 'Status', type: 'string' },
  { id: 'amount', label: 'Amount', type: 'number', decimals: 8 },
  { id: 'currency', label: 'Currency', type: 'string' },
  { id: 'ratioNew', label: 'Ratio new', type: 'number' },
  { id: 'ratioOld', label: 'Ratio old', type: 'number' },
  { id: 'declaredDate', label: 'Declared', type: 'date' },
  { id: 'recordDate', label: 'Record', type: 'date' },
  { id: 'payDate', label: 'Pay', type: 'date' },
  { id: 'effectiveDate', label: 'Effective', type: 'date' },
  { id: 'adjFactor', label: 'Adj factor', type: 'number', decimals: 5 },
  { id: 'newKey', label: 'New key', type: 'string' },
  { id: 'frequency', label: 'Frequency', type: 'string' },
  { id: 'grossOrNet', label: 'Gross/net', type: 'string' },
  { id: 'sourceId', label: 'Source', type: 'string' },
  { id: 'reviewState', label: 'Review', type: 'string' },
  { id: 'projected', label: 'Projected', type: 'boolean' },
  { id: 'projectionBasis', label: 'Projection basis', type: 'string' },
  { id: 'note', label: 'Note', type: 'string' },
  { id: 'caId', label: 'CA id', type: 'string' },
];

/** `members`: wide, one row per action, with a `section`-prefixed summary block appended. */
export const cacsMembersCsvColumns: CsvColumn[] = [
  { id: 'exDate', label: 'Ex-date', type: 'date' },
  { id: 'memberKey', label: 'Member', type: 'string' },
  { id: 'weight', label: 'Weight', type: 'number', decimals: 6 },
  { id: 'caType', label: 'Type', type: 'string' },
  { id: 'status', label: 'Status', type: 'string' },
  { id: 'amount', label: 'Amount', type: 'number', decimals: 8 },
  { id: 'currency', label: 'Currency', type: 'string' },
  { id: 'weightedAmount', label: 'Weighted', type: 'number', decimals: 10 },
  { id: 'ratioNew', label: 'Ratio new', type: 'number' },
  { id: 'ratioOld', label: 'Ratio old', type: 'number' },
  { id: 'payDate', label: 'Pay', type: 'date' },
  { id: 'sourceId', label: 'Source', type: 'string' },
  { id: 'reviewState', label: 'Review', type: 'string' },
  { id: 'projected', label: 'Projected', type: 'boolean' },
  { id: 'section', label: 'Section', type: 'string' },
];

export function cacsCsvColumns(_params: CacsParams, payload: CacsPayload): CsvColumn[] {
  return payload.variant === 'members' ? cacsMembersCsvColumns : cacsIssuerCsvColumns;
}

function issuerActionRow(a: CacsAction): (string | number | boolean | null)[] {
  return [
    'action',
    a.exDate,
    a.caType,
    a.status,
    a.amount,
    a.currency,
    a.ratioNew,
    a.ratioOld,
    a.declaredDate,
    a.recordDate,
    a.payDate,
    a.effectiveDate,
    a.adjFactor,
    a.newKey,
    a.frequency,
    a.grossOrNet,
    a.sourceId,
    a.reviewState,
    a.projected,
    a.projectionBasis,
    a.note,
    a.caId === null ? null : String(a.caId),
  ];
}

export function cacsCsvRows(payload: CacsPayload): (string | number | boolean | null)[][] {
  if (payload.variant === 'members') {
    const rows: (string | number | boolean | null)[][] = payload.actions.map((a) => [
      a.exDate,
      a.key,
      a.weight,
      a.caType,
      a.status,
      a.amount,
      a.currency,
      a.weightedAmount,
      a.ratioNew,
      a.ratioOld,
      a.payDate,
      a.sourceId,
      a.reviewState,
      a.projected,
      null,
    ]);
    const blanks = (): null[] => new Array<null>(13).fill(null);
    rows.push([null, 'exDateCount', payload.summary.exDateCount, ...blanks(), 'summary']);
    rows.push([
      null,
      'weightedCashPerIndexUnit',
      payload.summary.weightedCashPerIndexUnit,
      ...blanks(),
      'summary',
    ]);
    rows.push([null, 'coverage', payload.summary.coverage, ...blanks(), 'summary']);
    return rows;
  }

  const rows: (string | number | boolean | null)[][] = payload.actions.map(issuerActionRow);
  const width = cacsIssuerCsvColumns.length;
  for (const e of payload.earnings) {
    const row: (string | number | boolean | null)[] = new Array<null>(width).fill(null);
    row[0] = 'earnings';
    row[1] = e.acceptedAt.slice(0, 10);
    row[2] = 'earnings_8k';
    row[16] = 'sec.submissions';
    row[20] = `${e.items8k.join('|')} ${e.reportTiming}`;
    row[21] = e.accessionNo;
    rows.push(row);
  }
  const summary: [string, number | null][] = [
    ['ttmCashDividend', payload.summary.ttmCashDividend],
    ['ttmCount', payload.summary.ttmCount],
    ['cumulativeAdjFactor', payload.summary.cumulativeAdjFactor],
  ];
  for (const [key, value] of summary) {
    const row: (string | number | boolean | null)[] = new Array<null>(width).fill(null);
    row[0] = 'summary';
    row[2] = key;
    row[4] = value;
    rows.push(row);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§CACS "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

function cacsLive(_params: CacsParams, payload: CacsPayload): LiveSpec | null {
  if (payload.variant === 'members') return null;
  return {
    subjects: [`q:${String(payload.security.instrumentId)}`],
    fields: ['PX_LAST'] as FieldId[],
    conflationMs: 1000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlement pre-check
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The declared ids narrowed to those the evaluator can decide for this asset class.
 *
 * `field_licence`'s key is `(field_id, asset_class)` and its rows are generated from each field's
 * own `sources[].assetClass`, so an id the dictionary does not publish for the class on screen has
 * no row and is denied `FIELD_UNKNOWN` — a denial about nothing, which would tell a user their
 * contract is short when the truth is that the field does not apply. Filtering here keeps
 * `meta.entitlement` to real refusals. Exported because MEMB needs the identical narrowing.
 */
export function precheckFields(
  ids: readonly FieldId[],
  assetClass: AssetClass | null,
): FieldId[] {
  const out: FieldId[] = [];
  for (const id of ids) {
    const def = getField(id);
    if (def === undefined) continue;
    if (assetClass === null) {
      if (new Set(def.sources.map((s) => s.sourceId)).size === 1) out.push(id);
      continue;
    }
    const applies = def.sources.some(
      (s) =>
        s.assetClass === assetClass ||
        (s.assetClass === '*' && def.assetClasses.includes(assetClass)),
    );
    if (applies) out.push(id);
  }
  return out;
}

const CACS_ISSUER_FIELDS: readonly FieldId[] = Object.freeze([
  'CA_TYPE',
  'CA_STATUS',
  'CA_DECLARED_DT',
  'CA_EX_DT',
  'CA_RECORD_DT',
  'CA_PAY_DT',
  'CA_AMOUNT',
  'CA_RATIO_NEW',
  'CA_RATIO_OLD',
  'DVD_SH_12M',
  'DVD_YIELD',
  'PX_LAST',
] as FieldId[]);

const CACS_INDEX_FIELDS: readonly FieldId[] = Object.freeze([
  'CA_TYPE',
  'CA_STATUS',
  'CA_EX_DT',
  'CA_AMOUNT',
  'CA_RATIO_NEW',
  'CA_RATIO_OLD',
  'IDX_MEMBER_WEIGHT',
] as FieldId[]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CACS = defineFunction<typeof CacsParams, CacsPayload>({
  code: 'CACS',
  name: 'Corporate Actions',
  aliases: ['CA', 'ACTIONS'],
  tier: 2,
  category: 'reference',
  assetClasses: ['equity', 'etf', 'index'],
  requiresSecurity: true,
  variants: { equity: 'issuer', etf: 'issuer', index: 'members' },
  params: CacsParams,
  paramGrammar: {
    positional: [
      { name: 'from', type: 'date', optional: true },
      { name: 'to', type: 'date', optional: true },
    ],
    keyed: {
      T: { name: 'types', type: 'enum', values: CA_TYPES },
      ST: { name: 'status', type: 'enum', values: CA_STATUSES },
      E: { name: 'includeEarnings', type: 'boolean' },
      P: { name: 'includeProjected', type: 'boolean' },
      M: { name: 'members', type: 'int' },
      KNOWN: { name: 'knownAt', type: 'datetime' },
    },
  },
  fieldIds: (assetClass): FieldId[] =>
    precheckFields(assetClass === 'index' ? CACS_INDEX_FIELDS : CACS_ISSUER_FIELDS, assetClass),
  pageable: false,
  live: cacsLive,
  csv: {
    filename: (_params, ctx): string =>
      `CACS_${(ctx.display ?? 'security').replace(/ /g, '_')}_` +
      `${ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.csv`,
    columns: cacsCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => cacsCsvRows(payload),
  },
  help: {
    summary: 'Dividend, split, name-change and earnings timeline with status',
    description:
      'CACS is the corporate-action timeline for the security on the command line. Upcoming ' +
      'actions sit above the rule, history below it, and each row shows where it is on the ' +
      'estimated, announced, confirmed, paid ladder together with the price-adjustment factor it ' +
      'contributes to adjusted history. Cash dividends and splits come from the exchange-event ' +
      "feed; name and ticker changes are derived from the issuer's own SEC record; earnings dates " +
      'are the 8-K item 2.02 acceptance times. Rows badged PROJECTED are the resolver’s own ' +
      "estimate of the next ex-date from the issuer's payment cadence, never a published " +
      'announcement. Mergers, tenders, rights, calls and conversions have no reachable source in ' +
      'this build and are listed as unavailable with a reason rather than shown empty. Press K to ' +
      'see the timeline as it was known on an earlier date.',
    params: [
      { name: 'from', text: 'window start', example: 'CACS 2020-01-01' },
      { name: 'to', text: 'window end', example: 'CACS 2020-01-01 2027-01-01' },
      { name: 'types', text: 'corporate-action types', example: 'T=SPLIT' },
      {
        name: 'status',
        text: 'estimated, announced, confirmed, paid, cancelled',
        example: 'ST=ANNOUNCED',
      },
      { name: 'includeEarnings', text: '8-K item 2.02 dates', example: 'E=0' },
      { name: 'includeProjected', text: 'projected next ex-date', example: 'P=0' },
      { name: 'members', text: 'index only: constituents, 5–100', example: 'M=100' },
      { name: 'knownAt', text: 'point-in-time date', example: 'KNOWN=2025-01-01' },
    ],
    keys: [
      { key: 'Enter', action: 'provenance of the focused row' },
      { key: 'Shift+Enter', action: 'DES of the target security in the next panel' },
      { key: 'T', action: 'cycle the type filter' },
      { key: 'U', action: 'include or exclude estimated and cancelled rows' },
      { key: 'P', action: 'show or hide the projected row' },
      { key: 'K', action: 'set the point-in-time date' },
      { key: 'Home / End', action: 'widen the window backwards / forwards' },
      { key: 'M', action: 'index only: more constituents' },
      { key: 'E', action: 'earnings estimates (EE)' },
      { key: 'G', action: 'price chart with markers (GP)' },
      { key: 'Delete', action: 'the filings list (CF)' },
    ],
    sources: ['yahoo.chart', 'sec.submissions', 'sec.archives', 'ssga.holdings', 'internal.derived'],
    related: ['DES', 'EE', 'GP', 'HP', 'CF', 'CN'],
  },
  keymap: [
    { key: 'Enter', action: 'show-provenance', when: 'grid', description: 'Provenance of this row' },
    {
      key: 'Shift+Enter',
      action: 'open-target-next',
      when: 'grid',
      description: 'DES of the target security',
    },
    { key: 'T', action: 'cycle-types', description: 'All → dividends → splits → all' },
    { key: 'U', action: 'toggle-status', description: 'Include estimated and cancelled' },
    { key: 'P', action: 'toggle-projected', description: 'Show or hide the projected row' },
    { key: 'K', action: 'set-known-at', description: 'See the timeline as it was known' },
    { key: 'Home', action: 'window-back', when: 'grid', description: 'Two more years of history' },
    { key: 'End', action: 'window-fwd', when: 'grid', description: 'One more year ahead' },
    { key: 'M', action: 'more-members', when: 'grid', description: 'More constituents' },
    { key: 'E', action: 'open-ee', description: 'Earnings estimates' },
    { key: 'G', action: 'open-gp', description: 'Price chart with markers' },
    { key: 'Delete', action: 'open-cf', description: 'The filings list' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default CACS;
