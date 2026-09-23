// packages/core/src/functions/manifests/MEMB.ts
//
// `MEMB` — Index Members (FUNCTIONS_TIER2.md §MEMB L1728-1896, FUNCTIONS.md §6 L1100).
//
// The constituents of an index with their weights, shares and market values, optionally subtotalled
// by sector, country or asset category, and optionally diffed against an earlier snapshot date
// (adds, drops and weight moves in basis points — REF-07).
//
// Three honesty rules shape the payload, and all three are about saying where a number came from:
//
//  1. **Membership is the tracking fund's, not the index provider's.** SPX's roster is SPY's
//     N-PORT holdings or SSGA's daily file. `membership.via` says which fund, and
//     `MEMBERSHIP_VIA_PROXY_FUND` is on every such payload — weights are as of the file date.
//  2. **Neither membership source carries a GICS sector.** The N-PORT XML carries `assetCat` and
//     `issuerCat`; the SSGA sheet has a `Sector` column whose cell is the literal `-`. The sector
//     shown here is joined from `entity_classifications` (scheme `GICS`, source `wiki.sp500`), so
//     a MEMB payload cites **two** sources and the screen renders both attributions (DATA-09). A
//     member with no GICS row is `null`, grouped under `—`, with an `unavailable` entry naming the
//     gap — never inferred from the industry, the name or a neighbouring row.
//  3. **History goes back only as far as the captured filings.** A `compareDate` before the first
//     capture leaves `changes` null with `HISTORY_LIMITED_TO_CAPTURED_FILINGS`, and an index with
//     `indices.membership_source_id IS NULL` returns no list at all rather than a partial one.

import { z } from 'zod';

import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { precheckFields } from './CACS.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { SecurityRefInput } from '../schemas.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§MEMB "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const MEMB_SOURCES = ['any', 'sec.archives', 'ssga.holdings'] as const;
export const MEMB_GROUP_BY = ['none', 'gics_sector', 'country', 'asset_cat'] as const;
export const MEMB_SORTS = ['weight', 'name', 'key', 'shares'] as const;

export const MembParams = z.object({
  /** `'MEMB SPX'` when the panel has no index loaded. */
  index: SecurityRefInput.optional(),
  /** Membership snapshot date; undefined = the latest `as_of_date ≤ ctx.asOf.validAt`. */
  asOfDate: z.iso.date().optional(),
  /** Adds, drops and weight moves between `compareDate` and `asOfDate` (REF-07). */
  compareDate: z.iso.date().optional(),
  source: z.enum(MEMB_SOURCES).default('any'),
  groupBy: z.enum(MEMB_GROUP_BY).default('none'),
  sort: z.enum(MEMB_SORTS).default('weight'),
  /** Rows per page (`ctx.page`). */
  limit: z.number().int().min(10).max(500).default(100),
});
export type MembParams = z.infer<typeof MembParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§MEMB "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface MembIndexBlock {
  instrumentId: number;
  /** `'SPX Index'`. */
  key: string;
  name: string;
  /** `indices.code`, `'SPX'`. */
  code: string;
  provider: string | null;
  methodology: string | null;
  calcCurrency: string | null;
  constituentCount: number | null;
}

export type MembVia =
  | { kind: 'proxy_fund'; instrumentId: number; key: string }
  | { kind: 'direct' };

export interface MembMembership {
  asOfDate: string;
  sourceId: string;
  via: MembVia;
  count: number;
  /** Σ weight over the unpaged set, as a fraction (≈ 1). */
  weightSum: number;
  /** Every captured `as_of_date` for this index, newest first (REF-03 history extent). */
  availableDates: string[];
  provIdx: number;
}

export interface MembMember {
  instrumentId: number | null;
  key: string | null;
  name: string;
  cusip: string | null;
  isin: string | null;
  ticker: string | null;
  gicsSector: string | null;
  country: string | null;
  assetCat: string | null;
  /** Fraction (`index_members.weight`), never a percentage. */
  weight: number | null;
  shares: number | null;
  marketValue: number | null;
  px: ValueCell;
  chgPct: ValueCell;
  /** `weight × chgPct.v`; `null` when either is null. */
  contribPct: number | null;
  /** `'q:42'`, or `null` for an unresolved line. */
  subject: string | null;
}

export interface MembGroup {
  /** `'Information Technology' | 'US' | 'EC' | 'Unclassified'`. */
  key: string;
  label: string;
  weight: number;
  count: number;
  chgPctWeighted: number | null;
}

export interface MembChangeRow {
  instrumentId: number | null;
  key: string | null;
  name: string;
  weight: number | null;
}

export interface MembWeightMove {
  instrumentId: number | null;
  key: string | null;
  name: string;
  weightFrom: number;
  weightTo: number;
  deltaBp: number;
}

export interface MembChanges {
  compareDate: string;
  compareSourceId: string;
  adds: MembChangeRow[];
  drops: MembChangeRow[];
  weightMoves: MembWeightMove[];
  provIdx: number;
}

export interface MembPayload {
  /** `'index'` when launched on an index security; `'default'` for the `MEMB SPX` launch form. */
  variant: 'index' | 'default';
  index: MembIndexBlock;
  membership: MembMembership;
  members: MembMember[];
  /** `[]` when `groupBy = 'none'`. */
  groups: MembGroup[];
  /** `null` when `params.compareDate` is absent. */
  changes: MembChanges | null;
  unresolved: { count: number; reason: 'UNRESOLVED_IDENTIFIER' | null };
  notes: string[];
}

export const MEMB_NOTE_VIA_PROXY = 'MEMBERSHIP_VIA_PROXY_FUND';
export const MEMB_NOTE_HISTORY_LIMITED = 'HISTORY_LIMITED_TO_CAPTURED_FILINGS';
export const MEMB_NOTE_UNRESOLVED = 'UNRESOLVED_CONSTITUENTS';
export const MEMB_NOTE_NO_SOURCE = 'NO_MEMBERSHIP_SOURCE';
export const MEMB_NOTE_GICS_NOT_IN_SOURCE = 'GICS_NOT_IN_MEMBERSHIP_SOURCE';

/** The label a null grouping key is subtotalled under (an em dash on screen). */
export const MEMB_UNCLASSIFIED = 'Unclassified';
/** What the `gicsSector` column renders when the join found no row — never a guessed sector. */
export const MEMB_SECTOR_UNKNOWN_GLYPH = '—';

/** §MEMB step 4: at most this many capture dates are listed. */
export const MEMB_MAX_AVAILABLE_DATES = 24;
/** §MEMB step 9: a weight move smaller than this (1 bp) is not reported. */
export const MEMB_WEIGHT_MOVE_FLOOR = 0.0001;
/** §MEMB step 9: at most this many weight moves. */
export const MEMB_MAX_WEIGHT_MOVES = 100;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§MEMB "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `px`, `chgPct` and `contribPct` are deliberately **absent**: they are live values of a different
 * `asOf` than the membership file, and exporting them would break API-05's value identity between
 * the CSV and the JSON it claims to be.
 */
export const membCsvColumns: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'name', label: 'Name', type: 'string' },
  { id: 'ticker', label: 'Ticker', type: 'string' },
  { id: 'cusip', label: 'CUSIP', type: 'string' },
  { id: 'isin', label: 'ISIN', type: 'string' },
  { id: 'gicsSector', label: 'GICS sector', type: 'string' },
  { id: 'country', label: 'Country', type: 'string' },
  { id: 'assetCat', label: 'Asset category', type: 'string' },
  { id: 'weight', label: 'Weight', type: 'number', decimals: 10 },
  { id: 'shares', label: 'Shares', type: 'number', decimals: 4 },
  { id: 'marketValue', label: 'Market value', type: 'number', decimals: 2 },
  { id: 'asOfDate', label: 'As of', type: 'date' },
  { id: 'sourceId', label: 'Source', type: 'string' },
];

export function membCsvRows(payload: MembPayload): (string | number | boolean | null)[][] {
  const { membership } = payload;
  const rows: (string | number | boolean | null)[][] = payload.members.map((m) => [
    'member',
    m.key,
    m.name,
    m.ticker,
    m.cusip,
    m.isin,
    m.gicsSector,
    m.country,
    m.assetCat,
    m.weight,
    m.shares,
    m.marketValue,
    membership.asOfDate,
    membership.sourceId,
  ]);

  for (const g of payload.groups) {
    rows.push([
      'group',
      g.key,
      g.label,
      null,
      null,
      null,
      null,
      null,
      null,
      g.weight,
      g.count,
      null,
      membership.asOfDate,
      membership.sourceId,
    ]);
  }

  const changes = payload.changes;
  if (changes !== null) {
    for (const a of changes.adds) {
      rows.push([
        'add', a.key, a.name, null, null, null, null, null, null, a.weight, null, null,
        membership.asOfDate, membership.sourceId,
      ]);
    }
    for (const d of changes.drops) {
      rows.push([
        'drop', d.key, d.name, null, null, null, null, null, null, d.weight, null, null,
        changes.compareDate, changes.compareSourceId,
      ]);
    }
    for (const w of changes.weightMoves) {
      rows.push([
        'move', w.key, w.name, null, null, null, null, null, null, w.weightTo, null, w.deltaBp,
        membership.asOfDate, membership.sourceId,
      ]);
    }
  }

  rows.push([
    'index',
    payload.index.key,
    payload.index.name,
    null,
    null,
    null,
    null,
    null,
    null,
    membership.weightSum,
    membership.count,
    null,
    membership.asOfDate,
    membership.sourceId,
  ]);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§MEMB "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

function membLive(_params: MembParams, payload: MembPayload): LiveSpec | null {
  const indexSubject = `q:${String(payload.index.instrumentId)}`;
  const subjects = [
    indexSubject,
    ...payload.members
      .map((m) => m.subject)
      .filter((s): s is string => s !== null && s !== indexSubject),
  ];
  return {
    subjects,
    fields: ['PX_LAST', 'CHG_PCT_1D'] as FieldId[],
    conflationMs: 1000,
    essential: [indexSubject],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

const MEMB_FIELDS: readonly FieldId[] = Object.freeze([
  'IDX_MEMBER_WEIGHT',
  'IDX_MEMBER_SHARES',
  'IDX_MEMBER_SINCE',
  'PX_LAST',
  'CHG_PCT_1D',
  'NAME',
  'GICS_SECTOR_NAME',
] as FieldId[]);

export const MEMB = defineFunction<typeof MembParams, MembPayload>({
  code: 'MEMB',
  name: 'Index Members',
  aliases: ['MEMBERS'],
  tier: 2,
  category: 'reference',
  assetClasses: ['index'],
  /**
   * `false`: `MEMB SPX` launches with an empty panel and takes the index from its own argument
   * (§2.7). The resolver reports the missing-index case rather than the runner refusing it.
   */
  requiresSecurity: false,
  variants: { index: 'index' },
  params: MembParams,
  paramGrammar: {
    positional: [{ name: 'index', type: 'index', optional: true }],
    keyed: {
      DT: { name: 'asOfDate', type: 'date' },
      VS: { name: 'compareDate', type: 'date' },
      SRC: { name: 'source', type: 'enum', values: MEMB_SOURCES },
      BY: { name: 'groupBy', type: 'enum', values: MEMB_GROUP_BY },
      SORT: { name: 'sort', type: 'enum', values: MEMB_SORTS },
      N: { name: 'limit', type: 'int' },
    },
  },
  fieldIds: (assetClass): FieldId[] => precheckFields(MEMB_FIELDS, assetClass),
  pageable: true,
  live: membLive,
  csv: {
    filename: (_params, ctx): string =>
      `MEMB_${(ctx.display ?? 'index').replace(/[^A-Za-z0-9]+/g, '_')}_` +
      `${ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.csv`,
    columns: membCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => membCsvRows(payload),
  },
  help: {
    summary: 'Index constituents with weights, sector subtotals and adds/drops between dates',
    description:
      'MEMB lists the members of an index with their weights, shares and market values, and marks ' +
      'each row with its GICS sector and country. Type MEMB SPX to load an index directly, or run ' +
      'MEMB with an index in the panel. Press B to subtotal by sector, country or asset category, ' +
      'Q to open the same list as a live quote monitor, and C to pick a comparison date: the ' +
      'screen then shows what was added, what was dropped and which weights moved, in basis ' +
      'points. Membership comes from the regulatory filings of the fund that tracks the index ' +
      "(SEC N-PORT) or from the issuer's published holdings file, so weights are as of the file " +
      'date and the screen says which file it used. Sectors come from a third source again, ' +
      'because neither membership file carries one. Indices with no tracking-fund filing and no ' +
      'published holdings file show NO_MEMBERSHIP_SOURCE instead of a constituent list; history ' +
      'goes back only as far as the captured filings, which the screen also states.',
    params: [
      { name: 'index', text: 'index to load when the panel has none', example: 'MEMB SPX' },
      { name: 'asOfDate', text: 'membership snapshot date', example: 'DT=2026-06-30' },
      { name: 'compareDate', text: 'compare with this date for adds/drops', example: 'VS=2026-03-31' },
      { name: 'source', text: 'any, sec.archives or ssga.holdings', example: 'SRC=SSGA.HOLDINGS' },
      { name: 'groupBy', text: 'none, gics_sector, country or asset_cat', example: 'BY=GICS_SECTOR' },
      { name: 'sort', text: 'weight, name, key or shares', example: 'SORT=NAME' },
      { name: 'limit', text: 'rows per page, 10–500', example: 'N=250' },
    ],
    keys: [
      { key: 'Enter', action: 'description of the focused member' },
      { key: 'Shift+Enter', action: 'the same in the next panel' },
      { key: 'G', action: 'price chart of the focused member' },
      { key: 'Q', action: 'live monitor over the members' },
      { key: 'H', action: 'the fund file behind the membership' },
      { key: 'S', action: 'cycle the sort' },
      { key: 'B', action: 'cycle the grouping' },
      { key: 'D', action: 'set the membership date' },
      { key: 'C', action: 'set the comparison date' },
      { key: 'X', action: 'cycle the membership source' },
      { key: 'Ctrl+W', action: 'add this page to a watchlist' },
    ],
    sources: ['sec.archives', 'ssga.holdings', 'wiki.sp500'],
    related: ['QM', 'HDS', 'DES', 'WEI', 'EQS'],
  },
  keymap: [
    { key: 'Enter', action: 'open-des', when: 'grid', description: 'Description of this member' },
    { key: 'Shift+Enter', action: 'open-des-next', when: 'grid', description: 'DES in the next panel' },
    { key: 'G', action: 'open-gp', description: 'Price chart' },
    { key: 'Q', action: 'open-qm', description: 'Live monitor over the members' },
    { key: 'H', action: 'open-hds', description: 'The fund file behind the membership' },
    { key: 'S', action: 'cycle-sort', description: 'weight → name → key → shares' },
    { key: 'B', action: 'cycle-group-by', description: 'none → sector → country → asset category' },
    { key: 'D', action: 'set-as-of-date', description: 'Membership as of' },
    { key: 'C', action: 'set-compare-date', description: 'Compare with' },
    { key: 'X', action: 'cycle-source', description: 'any → sec.archives → ssga.holdings' },
    { key: 'Ctrl+W', action: 'add-watchlist', when: 'grid', description: 'Add the page to a watchlist' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default MEMB;
