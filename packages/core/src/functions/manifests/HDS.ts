// packages/core/src/functions/manifests/HDS.ts
//
// `HDS` — Holders (FUNCTIONS_TIER2.md §HDS L1534-1724, FUNCTIONS.md §6 L1099).
//
// Two questions, one screen: *who owns this security* (the `equity` variant) and *what does this
// fund own* (the `fund` variant). Both are answered from ingested holdings files — SEC N-PORT and
// the SSGA daily sheet — and the manifest's whole job is to make the **limits** of that answer part
// of the wire shape rather than a footnote:
//
//  - `institutional` is `{ holders: null, reason: '13F_NOT_AVAILABLE' }` on every equity run. There
//    is no 13F-HR source in this build (BRIEF §2, API.md §14.3): SEC full-text search is blocked
//    and no 13F fixture is recorded. The block is typed so that `holders` *cannot* be a list — a
//    screen renders it greyed with the reason, and a run that failed because a source is missing
//    would be the wrong answer to a question the rest of the payload answers perfectly well.
//  - `holderKind` admits `'13f'` because the wire shape reserves it, and the resolver never
//    produces one. The reservation is deliberate: the day a 13F source exists, the column already
//    means something, and no client has to be redeployed to understand it.
//  - `insiders.shares` and `insiders.transactions` are typed `null`. Forms 3/4/5 are *listed* with
//    their links; the ownership documents are not parsed in v1, and a share count nobody parsed is
//    a share count nobody may show.
//
// Coverage is the other honest limit: an owner that files neither N-PORT nor a public holdings file
// cannot appear, so an equity with no holder rows carries `HOLDERS_LIMITED_TO_SEEDED_FUNDS` rather
// than an empty grid that reads as "nobody owns this".

import { z } from 'zod';

import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { precheckFields } from './CACS.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§HDS "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const HDS_VIEWS = ['HOLDERS', 'INSIDERS'] as const;
export const HDS_SOURCES = ['any', 'sec.archives', 'ssga.holdings'] as const;
export const HDS_SORTS = ['weight', 'shares', 'marketValue', 'name'] as const;

export const HdsParams = z.object({
  /** Equity-variant tabs; ignored by the fund variant. */
  view: z.enum(HDS_VIEWS).default('HOLDERS'),
  /** Holdings-file date; undefined = the latest `as_of_date ≤ ctx.asOf.validAt`. */
  asOfDate: z.iso.date().optional(),
  source: z.enum(HDS_SOURCES).default('any'),
  /** Fraction, matching `etf_holdings.weight` units. */
  minWeight: z.number().min(0).max(1).default(0),
  sort: z.enum(HDS_SORTS).default('weight'),
  /** Rows per page (`ctx.page`). */
  limit: z.number().int().min(10).max(500).default(100),
});
export type HdsParams = z.infer<typeof HdsParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§HDS "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type HdsView = (typeof HDS_VIEWS)[number];
export type HdsSourceId = 'sec.archives' | 'ssga.holdings';

export interface HdsSecurity {
  instrumentId: number;
  /** `'AAPL US Equity'`. */
  key: string;
  name: string;
  issuerId: number;
  cik: string | null;
}

export interface HdsShareBase {
  sharesOut: ValueCell;
  floatPct: ValueCell;
  marketCap: ValueCell;
  px: ValueCell;
}

export interface HdsSummary {
  holderCount: number;
  sharesHeld: number | null;
  marketValueHeld: number | null;
  /** `sharesHeld / sharesOut.v`; `null` when `sharesOut` is blank. */
  pctSharesOutHeld: number | null;
  asOfDate: string | null;
  sources: HdsSourceId[];
  provIdx: number;
}

export interface HdsHolder {
  holderName: string;
  /** `'13f'` is reserved by the wire shape and never produced in v1 (`13F_NOT_AVAILABLE`). */
  holderKind: 'etf' | '13f';
  holderInstrumentId: number | null;
  /** `'SPY US Equity'` when the fund is itself in the universe. */
  holderKey: string | null;
  shares: number | null;
  marketValue: number | null;
  /** Fraction of the holder's own portfolio (`etf_holdings.weight`). */
  weightInHolder: number | null;
  /** `shares / sharesOut.v`, as a fraction. */
  pctSharesOut: number | null;
  asOfDate: string;
  sourceId: HdsSourceId;
  provIdx: number;
}

export interface HdsInsiderFiling {
  accessionNo: string;
  form: string;
  filedDate: string;
  acceptedAt: string | null;
  reportDate: string | null;
  primaryDocDesc: string | null;
  url: string;
  provIdx: number;
}

export interface HdsInsiders {
  filings: HdsInsiderFiling[];
  /** Always `null`: the Form 3/4/5 ownership documents are not parsed in v1. */
  shares: null;
  transactions: null;
  reason: 'INSIDER_HOLDINGS_NOT_PARSED';
}

export interface HdsEquityPayload {
  variant: 'equity';
  security: HdsSecurity;
  view: HdsView;
  shareBase: HdsShareBase;
  summary: HdsSummary;
  holders: HdsHolder[];
  insiders: HdsInsiders;
  /** No 13F source in the wedge; `holders` is typed `null` so a number cannot be invented. */
  institutional: { holders: null; reason: '13F_NOT_AVAILABLE' };
  notes: string[];
}

export interface HdsFund {
  instrumentId: number;
  /** `'SPY US Equity'`. */
  key: string;
  name: string;
  fundType: string;
  sponsor: string | null;
  cik: string | null;
  expenseRatio: number | null;
  trackedIndex: { instrumentId: number; key: string } | null;
}

export interface HdsFile {
  asOfDate: string;
  sourceId: HdsSourceId;
  count: number;
  netAssets: number | null;
  provIdx: number;
}

export interface HdsFundHolding {
  lineNo: number;
  holdingInstrumentId: number | null;
  key: string | null;
  name: string;
  cusip: string | null;
  isin: string | null;
  ticker: string | null;
  shares: number | null;
  marketValue: number | null;
  /** Fraction, never a percentage. */
  weight: number | null;
  /** N-PORT `assetCat`: `'EC'`, `'DBT'`, `'STIV'`. */
  assetCat: string | null;
  issuerCat: string | null;
  country: string | null;
  px: ValueCell;
  chgPct: ValueCell;
  /** `'q:42'`; `null` for an unresolved line, which is never subscribed. */
  subject: string | null;
}

export interface HdsFundPayload {
  variant: 'fund';
  fund: HdsFund;
  nav: { px: ValueCell; chgPct: ValueCell };
  file: HdsFile;
  holdings: HdsFundHolding[];
  byAssetCat: { assetCat: string; weight: number; count: number }[];
  unresolved: { count: number; reason: 'UNRESOLVED_IDENTIFIER' | null };
  notes: string[];
}

export type HdsPayload = HdsEquityPayload | HdsFundPayload;

export const HDS_NOTE_NO_13F = '13F_NOT_AVAILABLE';
export const HDS_NOTE_HOLDERS_LIMITED = 'HOLDERS_LIMITED_TO_SEEDED_FUNDS';
export const HDS_NOTE_INSIDERS_NOT_PARSED = 'INSIDER_HOLDINGS_NOT_PARSED';
export const HDS_NOTE_UNRESOLVED = 'UNRESOLVED_CONSTITUENTS';
export const HDS_NOTE_PROXY_LAGS = 'PROXY_FILE_LAGS_SESSION';
export const HDS_NOTE_NO_TRACKED_INDEX = 'NO_TRACKED_INDEX';

/** The one 13F reason string. Exported so the screen badge and the test quote the same bytes. */
export const HDS_NO_13F_DETAIL =
  '13F_NOT_AVAILABLE: no 13F-HR source in the wedge — SEC full-text search is blocked and no 13F ' +
  'fixture is recorded (BRIEF §2, API.md §14.3). Fund ownership below is from N-PORT/SSGA ' +
  'holdings files only.';

export const HDS_INSIDERS_DETAIL =
  'INSIDER_HOLDINGS_NOT_PARSED: Form 3/4/5 ownership documents are not parsed in v1; the filing ' +
  'record and its link are shown instead of share counts';

/** The insider forms §HDS step 6 lists. */
export const HDS_INSIDER_FORMS: readonly string[] = Object.freeze(['3', '4', '5', '4/A']);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§HDS "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Cell = string | number | boolean | null;

const HOLDERS_COLUMNS: CsvColumn[] = [
  { id: 'holderName', label: 'Holder', type: 'string' },
  { id: 'holderKind', label: 'Kind', type: 'string' },
  { id: 'holderKey', label: 'Holder key', type: 'string' },
  { id: 'shares', label: 'Shares', type: 'number', decimals: 4 },
  { id: 'marketValue', label: 'Market value', type: 'number', decimals: 2 },
  { id: 'weightInHolder', label: 'Weight in holder', type: 'number', decimals: 10 },
  { id: 'pctSharesOut', label: '% shares out', type: 'number', decimals: 10 },
  { id: 'asOfDate', label: 'As of', type: 'date' },
  { id: 'sourceId', label: 'Source', type: 'string' },
];

const INSIDERS_COLUMNS: CsvColumn[] = [
  { id: 'filedDate', label: 'Filed', type: 'date' },
  { id: 'form', label: 'Form', type: 'string' },
  { id: 'acceptedAt', label: 'Accepted', type: 'datetime' },
  { id: 'reportDate', label: 'Report date', type: 'date' },
  { id: 'accessionNo', label: 'Accession', type: 'string' },
  { id: 'primaryDocDesc', label: 'Description', type: 'string' },
  { id: 'url', label: 'URL', type: 'string' },
  { id: 'shares', label: 'Shares', type: 'number', decimals: 4 },
  { id: 'reason', label: 'Reason', type: 'string' },
];

/**
 * `px` and `chgPct` are deliberately absent: they are live values of a different `asOf` than the
 * file, and exporting them would break API-05's value identity between the CSV and the JSON.
 */
const FUND_COLUMNS: CsvColumn[] = [
  { id: 'lineNo', label: 'Line', type: 'number', decimals: 0 },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'name', label: 'Name', type: 'string' },
  { id: 'cusip', label: 'CUSIP', type: 'string' },
  { id: 'isin', label: 'ISIN', type: 'string' },
  { id: 'ticker', label: 'Ticker', type: 'string' },
  { id: 'shares', label: 'Shares', type: 'number', decimals: 4 },
  { id: 'marketValue', label: 'Market value', type: 'number', decimals: 2 },
  { id: 'weight', label: 'Weight', type: 'number', decimals: 10 },
  { id: 'assetCat', label: 'Asset category', type: 'string' },
  { id: 'issuerCat', label: 'Issuer category', type: 'string' },
  { id: 'country', label: 'Country', type: 'string' },
  { id: 'asOfDate', label: 'As of', type: 'date' },
  { id: 'sourceId', label: 'Source', type: 'string' },
];

export function hdsCsvColumns(params: HdsParams, payload: HdsPayload): CsvColumn[] {
  if (payload.variant === 'fund') return FUND_COLUMNS;
  return params.view === 'INSIDERS' ? INSIDERS_COLUMNS : HOLDERS_COLUMNS;
}

export function hdsCsvRows(payload: HdsPayload, params: HdsParams): Cell[][] {
  if (payload.variant === 'fund') {
    const rows: Cell[][] = payload.holdings.map((h) => [
      h.lineNo,
      h.key,
      h.name,
      h.cusip,
      h.isin,
      h.ticker,
      h.shares,
      h.marketValue,
      h.weight,
      h.assetCat,
      h.issuerCat,
      h.country,
      payload.file.asOfDate,
      payload.file.sourceId,
    ]);
    for (const cat of payload.byAssetCat) {
      rows.push([
        null,
        `_ASSETCAT_${cat.assetCat}`,
        cat.assetCat,
        null,
        null,
        null,
        cat.count,
        null,
        cat.weight,
        cat.assetCat,
        null,
        null,
        payload.file.asOfDate,
        payload.file.sourceId,
      ]);
    }
    return rows;
  }

  if (params.view === 'INSIDERS') {
    return payload.insiders.filings.map((f) => [
      f.filedDate,
      f.form,
      f.acceptedAt,
      f.reportDate,
      f.accessionNo,
      f.primaryDocDesc,
      f.url,
      null,
      HDS_NOTE_INSIDERS_NOT_PARSED,
    ]);
  }

  const s = payload.summary;
  const rows: Cell[][] = payload.holders.map((h) => [
    h.holderName,
    h.holderKind,
    h.holderKey,
    h.shares,
    h.marketValue,
    h.weightInHolder,
    h.pctSharesOut,
    h.asOfDate,
    h.sourceId,
  ]);
  const appended = (name: string, value: number | null): Cell[] => [
    name,
    null,
    null,
    value,
    null,
    null,
    null,
    s.asOfDate,
    s.sources.join('|'),
  ];
  rows.push(appended('_SUMMARY_HOLDER_COUNT', s.holderCount));
  rows.push(appended('_SUMMARY_SHARES_HELD', s.sharesHeld));
  rows.push(appended('_SUMMARY_MV_HELD', s.marketValueHeld));
  rows.push(appended('_SUMMARY_PCT_SH_OUT', s.pctSharesOutHeld));
  // The reason travels on the header's `# unavailable:` line; every numeric column here is empty.
  rows.push(['_INSTITUTIONAL_13F', '13f', null, null, null, null, null, null, null]);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§HDS "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

function hdsLive(_params: HdsParams, payload: HdsPayload): LiveSpec | null {
  if (payload.variant === 'equity') {
    const subject = `q:${String(payload.security.instrumentId)}`;
    return {
      subjects: [subject],
      fields: ['PX_LAST', 'CUR_MKT_CAP'] as FieldId[],
      conflationMs: 1000,
      essential: [subject],
    };
  }
  const fundSubject = `q:${String(payload.fund.instrumentId)}`;
  const subjects = [fundSubject];
  for (const row of payload.holdings) {
    if (row.subject !== null && !subjects.includes(row.subject)) subjects.push(row.subject);
  }
  return {
    subjects,
    fields: ['PX_LAST', 'CHG_PCT_1D'] as FieldId[],
    conflationMs: 1000,
    essential: [fundSubject],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The runner's step-5 pre-check set — the **plant-served** fields only, and deliberately not the
 * whole list §HDS's data-dependency row prints.
 *
 * `EntitlementDecision.effectiveTier` is the *minimum* across every field the pre-check names
 * (`entitlements/evaluator.ts`), and that tier is what gates every later plant read. `EQY_SH_OUT`
 * is licensed from `sec.companyfacts`, whose ceiling is `eod`; naming it here would cap the whole
 * run at `eod` and hand the screen a `PX_LAST` blanked with `TIER_EOD` — freezing the one cell the
 * same entry calls live. The fund variant has the identical problem through `IDX_MEMBER_WEIGHT`
 * and `IDX_MEMBER_SHARES` (`ssga.holdings`, `eod`).
 *
 * `FA.ts` made the same call for the same reason: the fund variant pre-checks `PX_LAST` and
 * `CHG_PCT_1D` and nothing else, and the filed and file-backed values travel through
 * `DataServices`, which carry their own entitlement decision. This follows that precedent.
 */
const HDS_EQUITY_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CUR_MKT_CAP',
] as FieldId[]);

const HDS_FUND_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_PCT_1D',
  'NAME',
] as FieldId[]);

export const HDS = defineFunction<typeof HdsParams, HdsPayload>({
  code: 'HDS',
  name: 'Holders',
  aliases: ['HOLD', 'HOLDERS'],
  tier: 2,
  category: 'fundamentals',
  assetClasses: ['equity', 'etf'],
  requiresSecurity: true,
  variants: { equity: 'equity', etf: 'fund' },
  params: HdsParams,
  paramGrammar: {
    positional: [{ name: 'view', type: 'enum', values: HDS_VIEWS, optional: true }],
    keyed: {
      DT: { name: 'asOfDate', type: 'date' },
      SRC: { name: 'source', type: 'enum', values: HDS_SOURCES },
      MIN: { name: 'minWeight', type: 'number' },
      SORT: { name: 'sort', type: 'enum', values: HDS_SORTS },
      N: { name: 'limit', type: 'int' },
    },
  },
  fieldIds: (assetClass): FieldId[] =>
    precheckFields(assetClass === 'etf' ? HDS_FUND_FIELDS : HDS_EQUITY_FIELDS, assetClass),
  pageable: true,
  live: hdsLive,
  csv: {
    filename: (_params, ctx): string =>
      `HDS_${(ctx.display ?? 'security').replace(/[^A-Za-z0-9]+/g, '_')}_` +
      `${ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.csv`,
    columns: (params, payload): CsvColumn[] => hdsCsvColumns(params, payload),
    rows: (payload, params): Cell[][] => hdsCsvRows(payload, params),
  },
  help: {
    summary: 'Fund and insider ownership from N-PORT/SSGA filings; 13F is not available',
    description:
      'HDS shows who owns a security and what a fund owns. On an equity it lists every ingested ' +
      'fund whose holdings file reports the name, with shares, market value, the weight the ' +
      'position has inside that fund and the percentage of shares outstanding it represents. ' +
      'Institutional 13F ownership is not available: there is no 13F source in this build, so ' +
      'that block shows 13F_NOT_AVAILABLE rather than a number. Press 2 for the issuer’s insider ' +
      'filings (Forms 3, 4 and 5); the filings and their links are listed, but the ownership ' +
      'documents are not parsed, so share counts show INSIDER_HOLDINGS_NOT_PARSED. On an ETF the ' +
      'screen shows the fund’s own holdings file — every line with shares, market value and ' +
      'weight, live prices for the lines that resolve to instruments, and subtotals by asset ' +
      'category. Coverage is limited to funds whose files are ingested: an owner that files ' +
      'neither N-PORT nor a public holdings file cannot appear.',
    params: [
      { name: 'view', text: 'HOLDERS or INSIDERS', example: 'HDS INSIDERS' },
      { name: 'asOfDate', text: 'holdings file date', example: 'DT=2026-03-31' },
      { name: 'source', text: 'any, sec.archives or ssga.holdings', example: 'SRC=SSGA.HOLDINGS' },
      { name: 'minWeight', text: 'minimum weight as a fraction', example: 'MIN=0.001' },
      { name: 'sort', text: 'weight, shares, marketValue or name', example: 'SORT=NAME' },
      { name: 'limit', text: 'rows per page, 10–500', example: 'N=250' },
    ],
    keys: [
      { key: '1', action: 'holders' },
      { key: '2', action: 'insider filings' },
      { key: 'D', action: 'set the holdings date' },
      { key: 'X', action: 'cycle source' },
      { key: 'S', action: 'cycle sort' },
      { key: 'M', action: 'index members of the tracked index' },
    ],
    sources: ['sec.archives', 'ssga.holdings', 'sec.submissions', 'sec.companyfacts'],
    related: ['MEMB', 'FA', 'CF', 'DES', 'PORT'],
  },
  keymap: [
    { key: '1', action: 'tab-view', description: 'Holders' },
    { key: '2', action: 'tab-view', description: 'Insider filings' },
    { key: 'Enter', action: 'open-holder', when: 'grid', description: 'Open the focused holder or holding' },
    { key: 'Shift+Enter', action: 'open-des-next', when: 'grid', description: 'DES in the next panel' },
    { key: 'G', action: 'open-gp', when: 'grid', description: 'Price chart' },
    { key: 'S', action: 'cycle-sort', description: 'weight → shares → marketValue → name' },
    { key: 'D', action: 'set-as-of-date', description: 'Holdings as of' },
    { key: 'X', action: 'cycle-source', description: 'any → sec.archives → ssga.holdings' },
    { key: 'M', action: 'open-memb', description: 'Members of the tracked index' },
    { key: 'F', action: 'open-fa', description: 'Financial analysis' },
    { key: 'C', action: 'open-cf', description: 'Company filings' },
    { key: 'Ctrl+W', action: 'add-watchlist', when: 'grid', description: 'Add the page to a watchlist' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default HDS;
