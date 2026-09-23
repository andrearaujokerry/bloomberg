// packages/core/src/functions/manifests/CN.ts
//
// `CN` — Company News (FUNCTIONS_TIER2.md §CN L644-808, FUNCTIONS.md §6 L1094).
//
// Two variants over one stream. `issuer` (equity, etf) is every headline and filing linked to the
// **issuer** of the security on screen, so two lines of the same company show the same news.
// `members` (index) is the union stream of the index's largest constituents, each row tagged with
// which members it belongs to — the "what moved my index today" screen.
//
// ## Linking is consumed, never re-derived (NEWS-02)
//
// A row appears because `news_entity_links` already carries a link at `confidence ≥ 0.9`, written
// by WP-09's linker under the precision-first rule (a one-word surface such as a bare ticker needs
// corroboration before a link is written at all). CN does not re-run that judgement, does not
// widen it, and does not fall back to a body search when a stream comes back empty — it says the
// stream is empty and why. `minConfidence` can only raise the floor.
//
// ## `fieldIds` is empty, like TOP / N / NI
//
// §CN names the `n:` field family as the pre-check set. Those seven ids have no `field_licence`
// row in this build — news is licensed per SOURCE, not per field, because all three sources back
// the same handful of subject fields — so pre-checking them would deny every one of them with
// `FIELD_UNKNOWN` and the runner would answer `403 ENTITLEMENT_DENIED` to every CN launch. The
// licence question is asked the way the evaluator asks it instead, per source, by
// `server/src/functions/shared/feedHealth.ts#newsSourceAccess`, which is what TOP, N and NI
// already do and what makes a dropped headline say which source it came from.

import { z } from 'zod';

import type { NewsRow } from '../shared/news.js';
import { newsCsvColumns, newsCsvRow } from '../shared/news.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import type { FieldId } from '../../types/fields.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§CN "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CN_WINDOWS = ['1D', '3D', '1W', '1M', '3M', '1Y'] as const;
export type CnWindow = (typeof CN_WINDOWS)[number];

export const CN_KINDS = ['story', 'video', 'filing', 'press_release', 'fed_release'] as const;
export type CnKind = (typeof CN_KINDS)[number];

/** `window` label → how many days back the window starts (§CN issuer step 1). */
export const CN_WINDOW_DAYS: Readonly<Record<CnWindow, number>> = Object.freeze({
  '1D': 1,
  '3D': 3,
  '1W': 7,
  '1M': 30,
  '3M': 91,
  '1Y': 365,
});

export const CnParams = z.object({
  window: z.enum(CN_WINDOWS).default('1M'),
  kinds: z.array(z.enum(CN_KINDS)).default(['story', 'video', 'filing', 'press_release']),
  /** `websearch_to_tsquery` over `news_items.tsv`, ANDed with the entity link. */
  q: z.string().max(200).optional(),
  /** `news_entity_links.confidence` floor; below 0.9 is never written (NEWS-02). */
  minConfidence: z.number().min(0.9).max(1).default(0.9),
  /** `members` variant only: how many constituents by weight. */
  members: z.number().int().min(5).max(50).default(25),
  limit: z.number().int().min(10).max(200).default(50),
});
export type CnParams = z.infer<typeof CnParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§CN "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A filing rendered as a headline (NEWS-04). Not a `news_items` row: `newsId` is `null` and
 * `accessionNo` identifies it.
 */
export interface CnFilingRow {
  newsId: null;
  accessionNo: string;
  /** `'8-K — Results of Operations and Financial Condition (Item 2.02)'`. */
  headline: string;
  /** `filings.primary_doc_desc`. */
  summary: string | null;
  sourceId: 'sec.submissions';
  feed: 'edgar';
  kind: 'filing';
  author: null;
  /** The form: `'8-K'`. */
  category: string;
  cik: string;
  items8k: string[] | null;
  /** `filings.accepted_at`. */
  publishedAt: string;
  /** `filings.captured_at`. */
  capturedAt: string;
  url: string;
  /** The form ends with `/A`. */
  isCorrection: boolean;
  machineGenerated: false;
  /** Exactly one issuer link, confidence 1.0, method `'cik'`. */
  links: NewsRow['links'];
  provIdx: number;
}

/** Discriminated by `newsId === null`. */
export type CnRow = NewsRow | CnFilingRow;

export interface CnCounts {
  story: number;
  video: number;
  filing: number;
  press_release: number;
  fed_release: number;
}

export interface CnWindowBlock {
  from: string;
  to: string;
  label: CnWindow;
}

export interface CnMemberTag {
  instrumentId: number;
  key: string;
  weight: number | null;
}

export type CnMemberRow = CnRow & { members: CnMemberTag[] };

export interface CnIssuerPayload {
  variant: 'issuer';
  security: { instrumentId: number; key: string; name: string };
  issuer: { issuerId: number | null; name: string; cik: string | null };
  window: CnWindowBlock;
  /** Newest first by `publishedAt`, tie-broken by `newsId` / `accessionNo` descending. */
  rows: CnRow[];
  counts: CnCounts;
  total: number;
  /** `'n:inst:42'`. */
  liveSubject: string;
  notes: string[];
}

export interface CnMembersPayload {
  variant: 'members';
  index: { instrumentId: number; key: string; name: string; indexId: number };
  membership: {
    asOfDate: string;
    sourceId: string;
    shown: number;
    total: number;
    provIdx: number;
  };
  window: CnWindowBlock;
  rows: CnMemberRow[];
  counts: CnCounts;
  total: number;
  liveSubjects: string[];
  notes: string[];
}

export type CnPayload = CnIssuerPayload | CnMembersPayload;

export const CN_NOTE_PRECISION = 'PRECISION_FIRST_LINKING';
export const CN_NOTE_LINK_OUT = 'BODY_NOT_STORED_LINK_OUT';
export const CN_NOTE_EMPTY = 'NO_ISSUER_HEADLINES_IN_WINDOW';
export const CN_NOTE_MEMBER_SUBSET = 'MEMBER_SUBSET';
export const CN_NOTE_MEMBERSHIP_STALE = 'MEMBERSHIP_STALE';
export const CN_NOTE_ITEM_LABEL_UNKNOWN = 'ITEM_LABEL_UNKNOWN';

/** §CN members step 4: membership older than this many days is flagged `MEMBERSHIP_STALE`. */
export const CN_MEMBERSHIP_STALE_DAYS = 45;

export function isCnFilingRow(row: CnRow): row is CnFilingRow {
  return row.newsId === null;
}

/** An empty tally, so a payload never omits a kind it happened not to see. */
export function cnEmptyCounts(): CnCounts {
  return { story: 0, video: 0, filing: 0, press_release: 0, fed_release: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§CN "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `issuer`: the shared news columns unchanged, plus the accession number. */
export const cnIssuerCsvColumns: CsvColumn[] = [
  ...newsCsvColumns,
  { id: 'accessionNo', label: 'Accession', type: 'string' },
];

/** `members`: the same columns prefixed by the member and its weight. */
export const cnMembersCsvColumns: CsvColumn[] = [
  { id: 'memberKey', label: 'Member', type: 'string' },
  { id: 'memberWeight', label: 'Weight', type: 'number', decimals: 6 },
  ...cnIssuerCsvColumns,
];

function cnRowCells(row: CnRow): (string | number | boolean | null)[] {
  if (isCnFilingRow(row)) {
    return [
      row.publishedAt,
      row.sourceId,
      row.feed,
      row.kind,
      row.headline,
      row.url,
      row.links.map((l) => l.display).join('|'),
      row.isCorrection,
      null,
      row.accessionNo,
    ];
  }
  return [...newsCsvRow(row), null];
}

export function cnCsvColumns(_params: CnParams, payload: CnPayload): CsvColumn[] {
  return payload.variant === 'members' ? cnMembersCsvColumns : cnIssuerCsvColumns;
}

/**
 * `members` emits one row per (headline × linked member): §1.6 rule 1 wants one table per
 * document, and a headline that moved three constituents is three facts about three securities.
 */
export function cnCsvRows(payload: CnPayload): (string | number | boolean | null)[][] {
  if (payload.variant === 'issuer') return payload.rows.map(cnRowCells);
  const out: (string | number | boolean | null)[][] = [];
  for (const row of payload.rows) {
    const cells = cnRowCells(row);
    if (row.members.length === 0) {
      out.push([null, null, ...cells]);
      continue;
    }
    for (const member of row.members) out.push([member.key, member.weight, ...cells]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§CN "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `n:` subjects take `f: []` ("all fields of the subject", API.md §6.1) and are never conflated:
 * one `delta` per headline in `publishedAt` order (BUS-02).
 */
function cnLive(_params: CnParams, payload: CnPayload): LiveSpec | null {
  const subjects =
    payload.variant === 'issuer' ? [payload.liveSubject] : [...payload.liveSubjects];
  if (subjects.length === 0) return null;
  return { subjects, fields: [], conflationMs: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CN = defineFunction<typeof CnParams, CnPayload>({
  code: 'CN',
  name: 'Company News',
  aliases: ['CNEWS'],
  tier: 2,
  category: 'news',
  assetClasses: ['equity', 'etf', 'index'],
  requiresSecurity: true,
  variants: { equity: 'issuer', etf: 'issuer', index: 'members' },
  params: CnParams,
  paramGrammar: {
    positional: [
      { name: 'window', type: 'enum', values: CN_WINDOWS, optional: true },
      { name: 'q', type: 'string', optional: true },
    ],
    keyed: {
      K: { name: 'kinds', type: 'enum', values: CN_KINDS },
      CONF: { name: 'minConfidence', type: 'number' },
      M: { name: 'members', type: 'int' },
      N: { name: 'limit', type: 'int' },
    },
    rest: { name: 'q', type: 'text' },
  },
  /** See the file header: news is licensed per source, and the `n:` ids have no field licence. */
  fieldIds: (): FieldId[] => [],
  pageable: true,
  live: cnLive,
  csv: {
    filename: (params, ctx): string =>
      `CN_${(ctx.display ?? 'security').replace(/ /g, '_')}_${params.window}_` +
      `${ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.csv`,
    columns: cnCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => cnCsvRows(payload),
  },
  help: {
    summary: 'Headlines and filings linked to this issuer, precision-first',
    description:
      'CN shows every headline linked to the issuer of the security on the command line, newest ' +
      "first, with that issuer's SEC filings folded in as headlines. Linking is precision-first: " +
      'a story appears only when it was matched to the company by CIK, exact ticker or exact name ' +
      'at confidence 0.9 or better, so a story that merely mentions the company in its body will ' +
      "not appear. Headlines are from Bloomberg's public RSS feeds and carry a link only — no " +
      'article body is stored or served. Press W to widen the window, F to show or hide filings, ' +
      '/ to search within the result and A to save an alert. On an index, CN shows the union ' +
      'stream of the largest constituents, tagged with which member each story belongs to.',
    params: [
      { name: 'window', text: '1D, 3D, 1W, 1M, 3M or 1Y', example: 'CN 1W' },
      { name: 'q', text: 'search within the headlines', example: 'CN 1M buyback' },
      { name: 'kinds', text: 'story, video, filing, press_release, fed_release', example: 'K=FILING' },
      { name: 'minConfidence', text: 'link-confidence floor, 0.9–1.0', example: 'CONF=1' },
      { name: 'members', text: 'index only: constituents to search, 5–50', example: 'M=50' },
      { name: 'limit', text: 'rows per page, 10–200', example: 'N=100' },
    ],
    keys: [
      { key: 'Enter', action: 'open the story at the publisher' },
      { key: 'Shift+Enter', action: 'DES for the linked security in the next panel' },
      { key: 'W', action: 'cycle the window' },
      { key: 'F', action: 'show or hide filings' },
      { key: 'S', action: 'stories and video only' },
      { key: '/', action: 'search within the result' },
      { key: 'A', action: 'save a news alert' },
      { key: 'C', action: 'corporate actions (CACS)' },
      { key: 'Delete', action: 'the full filings list (CF)' },
      { key: 'M', action: 'index only: search more constituents' },
    ],
    sources: ['bbg.rss', 'sec.submissions', 'sec.atom', 'sec.archives', 'ssga.holdings'],
    related: ['N', 'TOP', 'NI', 'CF', 'CACS', 'DES'],
  },
  keymap: [
    { key: 'Enter', action: 'open-story', when: 'grid', description: 'Open the story' },
    { key: 'Shift+Enter', action: 'open-des-next', when: 'grid', description: 'DES in the next panel' },
    { key: 'W', action: 'cycle-window', description: 'Cycle 1D → 3D → 1W → 1M → 3M → 1Y' },
    { key: 'F', action: 'toggle-filings', description: 'Show or hide filings' },
    { key: 'S', action: 'only-stories', description: 'Stories and video only' },
    { key: '/', action: 'search-within', description: 'Search inside the result' },
    { key: 'A', action: 'save-alert', description: 'Alert on the next headline' },
    { key: 'C', action: 'open-cacs', description: 'Corporate actions' },
    { key: 'Delete', action: 'open-cf', description: 'The full filings list' },
    { key: 'M', action: 'more-members', when: 'grid', description: 'Search more constituents' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default CN;
