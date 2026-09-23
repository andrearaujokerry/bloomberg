// packages/core/src/functions/manifests/EE.ts
//
// EE — Earnings (FUNCTIONS_TIER2.md §EE L159-272, FUNCTIONS.md §6).
//
// EE is the clearest case in the catalogue of the rule that the terminal does not invent data.
// A Bloomberg earnings screen is mostly *estimates*: consensus EPS, dispersion, surprise. This
// wedge has no estimates provider (BRIEF §2), so those columns are typed `null` — not optional,
// not `number | null`, but the literal `null` — and every run adds two `meta.unavailable` entries
// naming `NO_ESTIMATES_SOURCE`. The columns stay on the screen with an em dash and the reason as
// a tooltip, because a missing column teaches nothing and a zero is a lie (NEWS-08, §1.3 rule 6).
//
// What EE *does* have is the actuals — SEC XBRL quarters, point-in-time on `filed_at` — the 8-K
// item 2.02 acceptance instant that says whether the release was pre- or post-market, and the
// issuer's own filing cadence, which is what the "next expected report" date is projected from.
// Every one of those is a measurement, and the payload says which: `next.method` is `'cadence'`
// or `'prior_year'` and `next.basis` states the median gap the projection used.

import { z } from 'zod';

import { getField } from '../../fields/dictionary.js';
import type { FieldId } from '../../types/fields.js';
import { defineFunction, type CsvColumn, type CsvDocument, type KeyBinding } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§EE L175-181)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const EeMetrics = ['EPS_DIL', 'EPS_BASIC', 'REVENUE', 'NET_INC'] as const;
export type EeMetric = (typeof EeMetrics)[number];

export const EeParams = z.object({
  metric: z.enum(EeMetrics).default('EPS_DIL'),
  /** Quarterly rows shown. */
  periods: z.number().int().min(4).max(24).default(12),
  knownAt: z.iso.datetime().optional(),
});
export type EeParams = z.infer<typeof EeParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§EE L189-208)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `NO_ESTIMATES_SOURCE` in one place: the payload's, the CSV's and the screen's reason string. */
export const NO_ESTIMATES_SOURCE = 'NO_ESTIMATES_SOURCE';

/** The detail every estimate gap carries (§EE L233, BRIEF §2). */
export const NO_ESTIMATES_DETAIL =
  `${NO_ESTIMATES_SOURCE}: no consensus-estimates provider in the wedge (BRIEF §2)`;

export interface EeHistoryRow {
  periodEnd: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  actual: number | null;
  yoyPct: number | null;
  qoqPct: number | null;
  filedAt: string;
  accessionNo: string;
  form: string;
  url: string;
  /** From the 8-K item 2.02 acceptance time, in Eastern Time. */
  reportTiming: 'pre' | 'post' | 'intraday' | 'unknown';
  /** The 8-K item 2.02 `accepted_at`, or `null` when no such filing is stored. */
  reportedAt: string | null;
  /** Always `null`: there is no estimates provider (`NO_ESTIMATES_SOURCE`). */
  estimate: null;
  /** Always `null`, for the same reason. */
  surprisePct: null;
  provIdx: number;
}

export interface EeNextReport {
  expectedDate: string;
  window: [string, string];
  method: 'cadence' | 'prior_year';
  /** `'median gap of last 8 10-Q/10-K filings = 91 d'`. */
  basis: string;
  confidence: number;
}

export interface EePayload {
  variant: 'equity';
  issuer: { issuerId: number; name: string; cik: string; fiscalYearEnd: string | null };
  metric: EeMetric;
  unit: 'per_share' | 'ccy';
  history: EeHistoryRow[];
  ttm: { value: number | null; periodEnd: string | null };
  next: EeNextReport | null;
  consensus: { value: null; reason: typeof NO_ESTIMATES_SOURCE };
  /** History oldest → newest, for the `Sparkline` custom node. */
  sparkline: { t: number; v: number | null }[];
  knownAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fieldIds (§EE L216)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The tier document names four `EE_*` ids and `FA_FILED_AT`; none of them is in the dictionary's
 * 307 designed ids, so the filter drops them and the pre-check asks about the three that exist.
 * A denial on those blanks `actual` with its reason (ENTL-05) — which is the only part of this
 * screen an entitlement can blank, since the estimate columns are already empty for a *different*
 * reason and the payload keeps the two apart.
 */
const EE_FIELD_IDS: FieldId[] = [
  'EE_NEXT_REPORT_DT',
  'EE_EPS_ACTUAL_LAST',
  'EE_EPS_ESTIMATE',
  'EE_SURPRISE_PCT',
  'IS_EPS_DIL',
  'SALES_REV_TURN',
  'NET_INCOME',
  'FA_FILED_AT',
].filter((id): id is FieldId => getField(id) !== undefined);

/** The two dictionary ids the estimate gaps are reported under, whether or not the dictionary has them. */
export const EE_ESTIMATE_FIELDS = ['EE_EPS_ESTIMATE', 'EE_SURPRISE_PCT'] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§EE L227-229)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const eeCsvColumns: CsvColumn[] = [
  { id: 'periodEnd', label: 'Period end', type: 'date' },
  { id: 'fiscalYear', label: 'FY', type: 'number' },
  { id: 'fiscalPeriod', label: 'FP', type: 'string' },
  { id: 'metric', label: 'Metric', type: 'string' },
  { id: 'actual', label: 'Actual', type: 'number' },
  { id: 'yoyPct', label: 'YoY %', type: 'number' },
  { id: 'qoqPct', label: 'QoQ %', type: 'number' },
  { id: 'reportedAt', label: 'Reported at', type: 'datetime' },
  { id: 'reportTiming', label: 'Timing', type: 'string' },
  { id: 'filedAt', label: 'Filed', type: 'date' },
  { id: 'accessionNo', label: 'Accession no', type: 'string' },
  { id: 'form', label: 'Form', type: 'string' },
  { id: 'estimate', label: 'Estimate', type: 'number' },
  { id: 'surprisePct', label: 'Surprise %', type: 'number' },
  { id: 'estimateReason', label: 'Estimate reason', type: 'string' },
];

/** One row per history entry; `estimate`/`surprisePct` empty with the reason beside them. */
export function eeCsvRows(payload: EePayload): CsvDocument['rows'] {
  return payload.history.map((r) => [
    r.periodEnd,
    r.fiscalYear,
    r.fiscalPeriod,
    payload.metric,
    r.actual,
    r.yoyPct,
    r.qoqPct,
    r.reportedAt,
    r.reportTiming,
    r.filedAt,
    r.accessionNo,
    r.form,
    null,
    null,
    NO_ESTIMATES_SOURCE,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keyboard (§EE L221-226)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const EE_KEYMAP: readonly KeyBinding[] = [
  { key: 'M', action: 'cycle-metric', when: 'always', description: 'Cycle the reported metric' },
  { key: 'K', action: 'set-known-at', when: 'always', description: 'Set the point-in-time date' },
  { key: '+', action: 'more-periods', when: 'grid', description: 'Four more quarters' },
  { key: '-', action: 'fewer-periods', when: 'grid', description: 'Four fewer quarters' },
  { key: 'Enter', action: 'open-filing', when: 'grid', description: 'Open the filing on sec.gov' },
  {
    key: 'Shift+Enter',
    action: 'open-fa-next',
    when: 'grid',
    description: 'Open FA quarterly in the next panel',
  },
  { key: 'F', action: 'open-fa', when: 'always', description: 'Open FA (quarterly income statement)' },
  { key: 'C', action: 'open-cacs', when: 'always', description: 'Open CACS (corporate actions)' },
  { key: 'G', action: 'open-gp', when: 'always', description: 'Open GP with earnings markers' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const EE = defineFunction<typeof EeParams, EePayload>({
  code: 'EE',
  name: 'Earnings',
  aliases: ['ERN'],
  tier: 2,
  category: 'fundamentals',
  assetClasses: ['equity'],
  requiresSecurity: true,
  variants: { equity: 'equity' },
  params: EeParams,
  paramGrammar: {
    positional: [{ name: 'metric', type: 'enum', values: EeMetrics, optional: true }],
    keyed: {
      N: { name: 'periods', type: 'int' },
      KNOWN: { name: 'knownAt', type: 'datetime' },
    },
  },
  fieldIds: (): FieldId[] => [...EE_FIELD_IDS],
  pageable: false,
  // Filed actuals do not move on the wire, and there is no estimate feed to move either.
  live: null,
  csv: {
    filename: (_params, ctx): string => {
      const display = (ctx.display ?? 'security').replace(/ /g, '_');
      const asOf = ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      return `EE_${display}_${asOf}.csv`;
    },
    columns: eeCsvColumns,
    rows: (payload): CsvDocument['rows'] => eeCsvRows(payload),
  },
  help: {
    summary: 'Reported earnings history from SEC filings and the next expected report date',
    description:
      'EE lists quarterly actuals (diluted EPS by default; press M for basic EPS, revenue or net ' +
      'income) taken from SEC XBRL filings, with year-over-year change, the 8-K report time ' +
      '(pre-market or post-market) and the filing link. The next expected report date is ' +
      "projected from the issuer's own filing cadence. Consensus estimates, dispersion and " +
      'surprise are unavailable: the wedge has no estimates provider, so those columns show ' +
      'NO_ESTIMATES_SOURCE rather than a number.',
    params: [
      { name: 'metric', text: 'EPS_DIL, EPS_BASIC, REVENUE or NET_INC', example: 'EE REVENUE' },
      { name: 'periods', text: '4-24 quarters', example: 'N=20' },
      { name: 'knownAt', text: 'point-in-time date', example: 'KNOWN=2025-12-31' },
    ],
    keys: EE_KEYMAP.map((k) => ({ key: k.key, action: k.description })),
    sources: ['sec.companyfacts', 'sec.submissions'],
    related: ['FA', 'CACS', 'CN', 'GP', 'CF'],
  },
  keymap: EE_KEYMAP,
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default EE;
