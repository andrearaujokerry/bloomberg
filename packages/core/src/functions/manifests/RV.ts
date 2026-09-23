// packages/core/src/functions/manifests/RV.ts
//
// RV — Relative Valuation (FUNCTIONS_TIER2.md §RV L463-643, FUNCTIONS.md §6).
//
// One equity against its peer group on valuation multiples, with the peer distribution beside it.
// Four things about this manifest decide how the screen behaves:
//
//  1. **The multiples are resolver values at `ctx.asOf`, and the prices are live.** `live` declares
//     `PX_LAST` and `CHG_PCT_1D` only, so a price move flashes the price cell and leaves `PE_RATIO`
//     alone until the next run. The grid, the statistics table and the CSV therefore never disagree
//     (API-05); the screen states it with a `MULTIPLES AS OF <asOf>` badge rather than letting a
//     user discover it.
//  2. **A peer with no ingested fundamentals stays on the screen.** `RvRow.dataState` is
//     `'none'` with `unavailableReason:'FUNDAMENTALS_NOT_INGESTED'` and every multiple blank —
//     never a peer-group average filling the hole, and never a silently shorter peer list. Offline
//     this is the normal case, because companyfacts is ingested for one issuer.
//  3. **`n < 3` means no statistics at all**, not a median of two: `RvStat.reason` is
//     `'INSUFFICIENT_PEERS'` and every field is null.
//  4. **`metrics` is `MonitorColumn[]`.** The label, the rendering and the decimals of a column
//     come from `core/fields/dictionary.ts` through `monitorColumn`, so a metric renders the same
//     here as on QM, W and DES. Two ids `RvMetric` names — `PE_RATIO` and `EV_TO_EBITDA` — are not
//     in the dictionary's 307 designed ids, and {@link rvColumn} gives those two an explicit
//     column instead of throwing: see its docstring, which records the deviation.

import { z } from 'zod';

import { getField } from '../../fields/dictionary.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { monitorColumn, type MonitorColumn } from '../shared/monitor.js';
import { defineFunction, type CsvColumn, type CsvDocument, type KeyBinding } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§RV L474-495)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const RvMetrics = [
  'CUR_MKT_CAP',
  'PX_LAST',
  'CHG_PCT_1D',
  'RET_1Y',
  'PE_RATIO',
  'PX_TO_BOOK_RATIO',
  'PX_TO_SALES_RATIO',
  'EV_TO_EBITDA',
  'DVD_YIELD',
  'SALES_REV_TURN',
  'NET_INCOME',
  'IS_EPS_DIL',
  'NET_MARGIN',
  'SALES_GROWTH_YOY',
  'RETURN_COM_EQY',
  'BS_TOT_ASSET',
  'TOTAL_EQUITY',
  'FREE_CASH_FLOW',
] as const;
export const RvMetric = z.enum(RvMetrics);
export type RvMetric = (typeof RvMetrics)[number];

export const RvBases = [
  'SUB_INDUSTRY',
  'INDUSTRY',
  'INDUSTRY_GROUP',
  'SECTOR',
  'INDEX',
  'CUSTOM',
] as const;

export const RV_DEFAULT_METRICS: readonly RvMetric[] = [
  'CUR_MKT_CAP',
  'PE_RATIO',
  'PX_TO_BOOK_RATIO',
  'PX_TO_SALES_RATIO',
  'EV_TO_EBITDA',
  'NET_MARGIN',
  'RETURN_COM_EQY',
  'SALES_GROWTH_YOY',
  'DVD_YIELD',
];

export const RvParams = z.object({
  peerBasis: z.enum(RvBases).default('SUB_INDUSTRY'),
  /** CUSTOM only: command-line security refs (`'MSFT US Equity'`). */
  peers: z.array(z.string().max(32)).max(30).default([]),
  /** The INDEX basis, and the membership restriction for the GICS bases. */
  index: z.string().max(12).default('SPX'),
  restrictToIndex: z.boolean().default(true),
  maxPeers: z.number().int().min(3).max(30).default(12),
  metrics: z.array(RvMetric).min(1).max(10).default([...RV_DEFAULT_METRICS]),
  periodType: z.enum(['FY', 'TTM']).default('TTM'),
  /** `'metric'` = the first entry of `metrics`. */
  rank: z.enum(['CUR_MKT_CAP', 'name', 'metric']).default('CUR_MKT_CAP'),
  knownAt: z.iso.datetime().optional(),
});
export type RvParams = z.infer<typeof RvParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§RV L505-536)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type RvPeerBasis = (typeof RvBases)[number] | 'SIC';

export interface RvRow {
  instrumentId: number;
  key: string;
  name: string;
  /** `'q:117'`. */
  subject: string;
  issuerId: number | null;
  cik: string | null;
  exchCode: string;
  gicsSector: string | null;
  gicsSubIndustry: string | null;
  isTarget: boolean;
  /** Keyed by `RvMetric` id. */
  cells: Record<string, ValueCell>;
  fundamentals: {
    periodEnd: string | null;
    periodType: 'FY' | 'TTM';
    filedAt: string | null;
    accessionNo: string | null;
    provIdx: number;
  } | null;
  /** `'none'` = no `fin_statements` row at `knownAt`. */
  dataState: 'full' | 'partial' | 'none';
  unavailableReason: 'FUNDAMENTALS_NOT_INGESTED' | 'NO_CIK' | null;
}

export interface RvStat {
  metric: RvMetric;
  /** Peers with a non-null value; the target is never counted. */
  n: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  mean: number | null;
  target: number | null;
  /** Fraction 0..1 of peers at or below the target; `null` when `n < 3`. */
  targetPercentile: number | null;
  premiumToMedianPct: number | null;
  reason: 'INSUFFICIENT_PEERS' | null;
}

export interface RvPeerSet {
  basis: RvPeerBasis;
  requestedBasis: RvPeerBasis;
  scheme: 'GICS' | 'SIC' | 'INDEX' | 'CUSTOM';
  code: string | null;
  /** `'Systems Software (GICS 45103010)'`. */
  label: string;
  restrictedToIndex: string | null;
  candidates: number;
  returned: number;
  provIdx: number;
}

export interface RvPayload {
  variant: 'equity';
  target: RvRow;
  peerSet: RvPeerSet;
  /** One per `params.metrics`, in order. */
  metrics: MonitorColumn[];
  /** Ranked, target excluded. */
  peers: RvRow[];
  /** One per metric, same order as `metrics`. */
  stats: RvStat[];
  periodType: 'FY' | 'TTM';
  knownAt: string;
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Columns
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The column one metric renders as.
 *
 * `monitorColumn` throws on an id the dictionary does not carry, and it is right to: a monitor
 * column naming an unknown field is a manifest bug. Two `RvMetric` ids are in exactly that
 * position — `PE_RATIO` and `EV_TO_EBITDA` are named by FUNCTIONS_TIER2 §RV and are **not** among
 * the dictionary's 307 designed ids (nor are `TOTAL_EQUITY`, `FREE_CASH_FLOW` and
 * `RETURN_COM_EQY`, which the same entry names). Adding a field def is not this task's to make and
 * dropping the metric would change the documented parameter set, so the fallback below gives an
 * unknown id an explicit column — a ratio rendered as a plain number, one decimal — and every
 * known id still goes through `monitorColumn`, unchanged.
 */
export function rvColumn(metric: RvMetric): MonitorColumn {
  if (getField(metric) !== undefined) return monitorColumn(metric);
  const label = RV_FALLBACK_LABELS[metric] ?? metric;
  return { id: metric, label, fmt: 'px', decimals: 2 };
}

const RV_FALLBACK_LABELS: Readonly<Partial<Record<RvMetric, string>>> = {
  PE_RATIO: 'Price / earnings',
  EV_TO_EBITDA: 'EV / EBITDA',
  TOTAL_EQUITY: 'Total equity',
  FREE_CASH_FLOW: 'Free cash flow',
  RETURN_COM_EQY: 'Return on equity',
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fieldIds (§RV L545)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The pre-check set is the **plant-served** fields, not the twenty-two ids §RV lists.
 *
 * DES.ts states the rule once and every polymorphic screen meets it: the runner's step-5 decision
 * is also what gates the plant, and `effectiveTier` is the **minimum** over the fields asked
 * about. `SALES_REV_TURN`, `GICS_SECTOR_NAME`, `SIC_CODE` and the rest of §RV's list are sourced
 * from `sec.companyfacts`, `wiki.sp500` and `sec.submissions`, all capped at `eod` in
 * `licence_registry`. Asking about them together with `PX_LAST` drops the decision to `eod`, and
 * `policyTier.view` then freezes every price cell in the peer grid on the official close — so a
 * screen whose whole point is live prices beside stored multiples would show neither moving.
 *
 * The fundamentals are not thereby un-audited: they are read through `DataServices`, which refuse
 * to be constructed without a decision of their own, and every multiple cites the filing it came
 * from. {@link RV_SCREEN_FIELD_IDS} keeps §RV's full list for HELP, which is what it is for.
 */
const RV_FIELD_IDS: FieldId[] = ['PX_LAST', 'CHG_PCT_1D'].filter(
  (id): id is FieldId => getField(id) !== undefined,
);

/** Every field the screen shows, intersected with the dictionary — HELP's list, not the gate's. */
export const RV_SCREEN_FIELD_IDS: FieldId[] = [
  'PX_LAST',
  'CHG_PCT_1D',
  'RET_1Y',
  'CUR_MKT_CAP',
  'EQY_SH_OUT',
  'PE_RATIO',
  'PX_TO_BOOK_RATIO',
  'PX_TO_SALES_RATIO',
  'EV_TO_EBITDA',
  'DVD_YIELD',
  'SALES_REV_TURN',
  'NET_INCOME',
  'IS_EPS_DIL',
  'NET_MARGIN',
  'SALES_GROWTH_YOY',
  'RETURN_COM_EQY',
  'BS_TOT_ASSET',
  'TOTAL_EQUITY',
  'FREE_CASH_FLOW',
  'GICS_SECTOR_NAME',
  'SIC_CODE',
  'FA_FILED_AT',
].filter((id): id is FieldId => getField(id) !== undefined);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§RV L590-597)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const RV_CSV_PREFIX: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'name', label: 'Name', type: 'string' },
  { id: 'cik', label: 'CIK', type: 'string' },
  { id: 'gicsSector', label: 'GICS sector', type: 'string' },
  { id: 'gicsSubIndustry', label: 'GICS sub-industry', type: 'string' },
  { id: 'periodEnd', label: 'Period end', type: 'string' },
  { id: 'filedAt', label: 'Filed at', type: 'string' },
  { id: 'dataState', label: 'Data', type: 'string' },
];

export function rvCsvColumns(payload: RvPayload): CsvColumn[] {
  return [
    ...RV_CSV_PREFIX,
    ...payload.metrics.map((m): CsvColumn => {
      const column: CsvColumn = { id: m.id, label: m.label, type: 'number' };
      return m.decimals === undefined ? column : { ...column, decimals: m.decimals };
    }),
  ];
}

/** The ten statistic rows, in the order the screen shows them. */
const RV_STAT_KEYS = [
  'min',
  'p25',
  'median',
  'p75',
  'max',
  'mean',
  'n',
  'target',
  'percentile',
  'premiumToMedianPct',
] as const;

const statValue = (stat: RvStat, key: (typeof RV_STAT_KEYS)[number]): number | null => {
  switch (key) {
    case 'n':
      return stat.n;
    case 'percentile':
      return stat.targetPercentile;
    default:
      return stat[key];
  }
};

/** target row, one row per peer, then ten `stat` rows (§1.6 rule 3's long format). */
export function rvCsvRows(payload: RvPayload): CsvDocument['rows'] {
  const metricIds = payload.metrics.map((m) => m.id);
  const rowFor = (section: string, r: RvRow): (string | number | boolean | null)[] => [
    section,
    r.key,
    r.name,
    r.cik,
    r.gicsSector,
    r.gicsSubIndustry,
    r.fundamentals?.periodEnd ?? null,
    r.fundamentals?.filedAt ?? null,
    r.dataState,
    ...metricIds.map((id) => {
      const v = r.cells[id]?.v;
      return typeof v === 'number' ? v : null;
    }),
  ];

  const rows: CsvDocument['rows'] = [rowFor('target', payload.target)];
  for (const peer of payload.peers) rows.push(rowFor('peer', peer));
  for (const key of RV_STAT_KEYS) {
    rows.push([
      'stat',
      key,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      ...metricIds.map((id) => {
        const stat = payload.stats.find((s) => s.metric === id);
        return stat === undefined ? null : statValue(stat, key);
      }),
    ]);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keyboard (§RV L570-586)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const RV_KEYMAP: readonly KeyBinding[] = [
  { key: 'B', action: 'cycle-basis', when: 'always', description: 'Widen or narrow the peer basis' },
  { key: 'P', action: 'cycle-period-type', when: 'always', description: 'TTM or fiscal year' },
  { key: 'R', action: 'toggle-restrict', when: 'always', description: 'Restrict peers to the index' },
  { key: 'X', action: 'set-index', when: 'always', description: 'Set the index code' },
  { key: '+', action: 'more-peers', when: 'grid', description: 'Four more peers' },
  { key: '-', action: 'fewer-peers', when: 'grid', description: 'Four fewer peers' },
  { key: 'M', action: 'add-metric', when: 'grid', description: 'Add a metric column' },
  { key: 'Delete', action: 'remove-metric', when: 'grid', description: 'Remove the focused column' },
  { key: 'A', action: 'add-peer', when: 'always', description: 'Add a peer by ticker' },
  { key: 'K', action: 'set-known-at', when: 'always', description: 'Set the point-in-time date' },
  { key: 'Enter', action: 'open-des', when: 'grid', description: 'Open DES on the focused row' },
  {
    key: 'Shift+Enter',
    action: 'open-des-next',
    when: 'grid',
    description: 'Open DES in the next panel',
  },
  { key: 'Alt+F', action: 'open-fa', when: 'grid', description: 'Open FA for the focused row' },
  { key: 'E', action: 'open-ee', when: 'grid', description: 'Open EE for the focused row' },
  { key: 'G', action: 'open-gp', when: 'grid', description: 'Open GP for the focused row' },
  { key: 'Q', action: 'open-eqs', when: 'always', description: 'Screen the peer group in EQS' },
  { key: 'Ctrl+W', action: 'add-watchlist', when: 'grid', description: 'Add the peer set to a watchlist' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const RV = defineFunction<typeof RvParams, RvPayload>({
  code: 'RV',
  name: 'Relative Valuation',
  aliases: ['COMP', 'PEERS'],
  tier: 2,
  category: 'fundamentals',
  assetClasses: ['equity'],
  requiresSecurity: true,
  variants: { equity: 'equity' },
  params: RvParams,
  paramGrammar: {
    positional: [{ name: 'peerBasis', type: 'enum', values: RvBases, optional: true }],
    keyed: {
      IDX: { name: 'index', type: 'index' },
      N: { name: 'maxPeers', type: 'int' },
      PT: { name: 'periodType', type: 'enum', values: ['FY', 'TTM'] },
      RANK: { name: 'rank', type: 'enum', values: ['CUR_MKT_CAP', 'name', 'metric'] },
      COLS: { name: 'metrics', type: 'string' },
      RESTRICT: { name: 'restrictToIndex', type: 'boolean' },
      KNOWN: { name: 'knownAt', type: 'datetime' },
    },
    rest: { name: 'peers', type: 'text' },
  },
  fieldIds: (): FieldId[] => [...RV_FIELD_IDS],
  pageable: false,
  live: (_params, payload) => ({
    subjects: [payload.target.subject, ...payload.peers.map((p) => p.subject)],
    fields: ['PX_LAST', 'CHG_PCT_1D'],
    conflationMs: 1000,
    essential: [payload.target.subject],
  }),
  csv: {
    filename: (params, ctx): string => {
      const display = (ctx.display ?? 'security').replace(/ /g, '_');
      const asOf = ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      return `RV_${display}_${params.periodType}_${asOf}.csv`;
    },
    columns: (_params, payload): CsvColumn[] => rvCsvColumns(payload),
    rows: (payload): CsvDocument['rows'] => rvCsvRows(payload),
  },
  help: {
    summary: 'Peer set and comparative multiples for one equity against its GICS group',
    description:
      'RV builds a peer set for the loaded equity and compares it on valuation multiples, ' +
      'margins, growth and returns. By default peers are the other S&P 500 members in the same ' +
      'GICS sub-industry; press B to widen to industry, industry group or sector, R to drop the ' +
      'index restriction, or type RV CUSTOM with a list of tickers to compare names of your own ' +
      'choosing. Multiples are computed from the latest SEC filings known at the "known at" date ' +
      '— press K to move it and see the comparison as it stood then, P to switch between trailing ' +
      'twelve months and fiscal year. The statistics block gives the peer minimum, quartiles, ' +
      'median, maximum and mean for each column, where the target sits in that distribution, and ' +
      'its premium or discount to the median. A peer whose SEC filings have not yet been ingested ' +
      'stays on the screen with blank multiples and is excluded from the statistics: RV never ' +
      'fills a gap with a peer-group average. Prices are live; the multiples are as of the run, ' +
      'which the header states.',
    params: [
      {
        name: 'peerBasis',
        text: 'SUB_INDUSTRY, INDUSTRY, INDUSTRY_GROUP, SECTOR, INDEX or CUSTOM',
        example: 'RV SECTOR',
      },
      { name: 'peers', text: 'explicit peer list for CUSTOM', example: 'RV MSFT US Equity' },
      { name: 'index', text: 'index code for the INDEX basis and the restriction', example: 'IDX=SPX' },
      { name: 'restrictToIndex', text: 'keep only index members as peers', example: 'RESTRICT=0' },
      { name: 'maxPeers', text: '3-30 peers', example: 'N=20' },
      { name: 'metrics', text: 'metric ids to show', example: 'COLS=PE_RATIO,EV_TO_EBITDA' },
      { name: 'periodType', text: 'TTM or FY', example: 'PT=FY' },
      { name: 'rank', text: 'peer ordering: CUR_MKT_CAP, name or metric', example: 'RANK=name' },
      { name: 'knownAt', text: 'point-in-time date', example: 'KNOWN=2026-06-01' },
    ],
    keys: RV_KEYMAP.map((k) => ({ key: k.key, action: k.description })),
    sources: [
      'sec.companyfacts',
      'sec.submissions',
      'wiki.sp500',
      'sec.archives',
      'ssga.holdings',
      'cboe.quotes',
      'yahoo.chart',
      'internal.derived',
    ],
    related: ['FA', 'EE', 'EQS', 'MEMB', 'DES', 'CF'],
  },
  keymap: RV_KEYMAP,
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default RV;
