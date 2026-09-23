// packages/core/src/functions/manifests/CF.ts
//
// CF — Company Filings (FUNCTIONS_TIER2.md §CF L999-1155, FUNCTIONS.md §6).
//
// One variant, `issuer`, for both `equity` and `etf`: an ETF is a filer like any other and only
// its form mix differs (`NPORT-P`, `N-CEN`, `485BPOS` instead of `10-K`, `10-Q`, `8-K`). The
// `formCounts` block makes that difference visible without a second code path, and `latest`
// carries a `fundHoldings` slot beside the three periodic ones so a fund's newest N-PORT has a
// place to be named (§CF L1010).
//
// Three standing gaps are declared on every run rather than discovered by a user (§1.3 rule 6):
//
//  * `FILING_FULLTEXT_UNAVAILABLE` — `efts.sec.gov` is not reachable from this network, which is
//    why `CfParams` has no `q` at all. A search box that silently matched nothing would be worse
//    than no search box.
//  * `DOCUMENT_NOT_STORED_LINK_OUT` — documents are linked on sec.gov, never stored or proxied.
//  * `HISTORY_LIMITED_RECENT_FILE` — only the recent window of `submissions/CIK…json` is ingested;
//    the older `filings.files[]` shards are not fetched in v1, so `coverage.recentOnly` says when
//    the window the user is looking at is the file's, not the issuer's.
//
// FORM_GROUPS and EIGHT_K_ITEMS live in this file rather than in the
// `core/functions/shared/secForms.ts` the tier document names: that module is not part of this
// task's file list and nothing else needs it yet. Both are exported, so moving them later is a
// re-export rather than a rewrite.

import { z } from 'zod';

import { getField } from '../../fields/dictionary.js';
import type { FieldId } from '../../types/fields.js';
import { defineFunction, type CsvColumn, type CsvDocument, type KeyBinding } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Form groups and 8-K items (§CF L1024)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CfGroups = ['ALL', 'PERIODIC', 'CURRENT', 'OWNERSHIP', 'FUND', 'PROXY'] as const;
export type CfGroup = (typeof CfGroups)[number];
export type CfFormGroup = Exclude<CfGroup, 'ALL'> | 'OTHER';

/** `ALL` is the empty list, which means "no form filter" rather than "no forms". */
export const FORM_GROUPS: Readonly<Record<CfGroup, readonly string[]>> = Object.freeze({
  ALL: [],
  PERIODIC: ['10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '40-F'],
  CURRENT: ['8-K', '8-K/A', '6-K'],
  OWNERSHIP: ['3', '4', '5', 'SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A', '13F-HR'],
  FUND: ['NPORT-P', 'N-CEN', 'N-30D', '485BPOS', '497'],
  PROXY: ['DEF 14A', 'DEFA14A', 'PRE 14A'],
});

/** Form → its group, the reverse of {@link FORM_GROUPS}; an unlisted form is `OTHER`. */
export function formGroupOf(form: string): CfFormGroup {
  const upper = form.toUpperCase();
  for (const group of CfGroups) {
    if (group === 'ALL') continue;
    if (FORM_GROUPS[group].some((f) => f.toUpperCase() === upper)) return group;
  }
  return 'OTHER';
}

/** The 8-K item codes EDGAR publishes, for the `itemLabels` column. */
export const EIGHT_K_ITEMS: Readonly<Record<string, string>> = Object.freeze({
  '1.01': 'Entry into a Material Definitive Agreement',
  '1.02': 'Termination of a Material Definitive Agreement',
  '1.03': 'Bankruptcy or Receivership',
  '1.04': 'Mine Safety — Reporting of Shutdowns',
  '1.05': 'Material Cybersecurity Incidents',
  '2.01': 'Completion of Acquisition or Disposition of Assets',
  '2.02': 'Results of Operations and Financial Condition',
  '2.03': 'Creation of a Direct Financial Obligation',
  '2.04': 'Triggering Events That Accelerate a Financial Obligation',
  '2.05': 'Costs Associated with Exit or Disposal Activities',
  '2.06': 'Material Impairments',
  '3.01': 'Notice of Delisting or Failure to Satisfy a Listing Rule',
  '3.02': 'Unregistered Sales of Equity Securities',
  '3.03': 'Material Modification to Rights of Security Holders',
  '4.01': 'Changes in Registrant’s Certifying Accountant',
  '4.02': 'Non-Reliance on Previously Issued Financial Statements',
  '5.01': 'Changes in Control of Registrant',
  '5.02': 'Departure or Election of Directors or Officers',
  '5.03': 'Amendments to Articles of Incorporation or Bylaws',
  '5.04': 'Temporary Suspension of Trading Under Employee Benefit Plans',
  '5.05': 'Amendment to Registrant’s Code of Ethics',
  '5.07': 'Submission of Matters to a Vote of Security Holders',
  '5.08': 'Shareholder Director Nominations',
  '6.01': 'ABS Informational and Computational Material',
  '7.01': 'Regulation FD Disclosure',
  '8.01': 'Other Events',
  '9.01': 'Financial Statements and Exhibits',
});

/** `'Item 2.02'` when the code is not one EDGAR documents (footer note `ITEM_LABEL_UNKNOWN`). */
export function itemLabel(code: string): string {
  return EIGHT_K_ITEMS[code] ?? `Item ${code}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§CF L1013-1023)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CfParams = z.object({
  /** `[]` = every form; matched case-insensitively against `filings.form`. */
  forms: z.array(z.string().max(12)).max(12).default([]),
  group: z.enum(CfGroups).default('ALL'),
  /** Default: `validAt − 3 years`. */
  from: z.iso.date().optional(),
  /** Default: `validAt`. */
  to: z.iso.date().optional(),
  /** 8-K item codes; a row is kept when its `items` is a superset. */
  items: z.array(z.string().max(6)).max(12).default([]),
  xbrlOnly: z.boolean().default(false),
  limit: z.number().int().min(10).max(200).default(50),
  knownAt: z.iso.datetime().optional(),
});
export type CfParams = z.infer<typeof CfParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§CF L1028-1063)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface CfFiling {
  accessionNo: string;
  form: string;
  formGroup: CfFormGroup;
  filedDate: string;
  /** `filings.accepted_at` — the public-knowledge instant, and what `knownAt` bounds. */
  acceptedAt: string | null;
  reportDate: string | null;
  items: string[] | null;
  itemLabels: string[] | null;
  primaryDoc: string;
  primaryDocDesc: string | null;
  isXbrl: boolean;
  isInlineXbrl: boolean;
  sizeBytes: number | null;
  url: string;
  isAmendment: boolean;
  /** The filing this one amends, when a stored one matches on form and report date. */
  amends: string | null;
  provIdx: number;
}

export interface CfPayload {
  variant: 'issuer';
  security: { instrumentId: number; key: string; name: string; assetClass: 'equity' | 'etf' };
  issuer: {
    issuerId: number | null;
    name: string;
    cik: string | null;
    sic: string | null;
    sicDescription: string | null;
    filerCategory: string | null;
    /** `'MMDD'`. */
    fiscalYearEnd: string | null;
    entityType: string | null;
    formerNames: { name: string; from: string; to: string }[];
    website: string | null;
  };
  filter: {
    forms: string[];
    group: CfGroup;
    items: string[];
    xbrlOnly: boolean;
    from: string;
    to: string;
  };
  /** `accepted_at DESC`, then `accessionNo DESC`. */
  filings: CfFiling[];
  /** Over the whole window, not the page. */
  formCounts: { form: string; formGroup: CfFormGroup; count: number; newest: string }[];
  latest: {
    annual: CfFiling | null;
    quarterly: CfFiling | null;
    current8k: CfFiling | null;
    fundHoldings: CfFiling | null;
  };
  coverage: {
    from: string | null;
    to: string | null;
    sourceId: 'sec.submissions';
    recentOnly: boolean;
    countInStore: number;
  };
  total: number;
  knownAt: string;
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Standing reason codes (§CF L1120-1128)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FILING_FULLTEXT_DETAIL =
  'FILING_FULLTEXT_UNAVAILABLE: the SEC full-text search endpoint (efts.sec.gov) is blocked from ' +
  'this network, so filings cannot be searched by document text; filter by form, 8-K item and ' +
  'date instead (BRIEF §2)';

export const DOCUMENT_LINK_OUT_DETAIL =
  'DOCUMENT_NOT_STORED_LINK_OUT: filing documents are linked on sec.gov and never stored, ' +
  'proxied or served by the terminal';

/** `coverage.from` is appended by the resolver, which is the only part that varies. */
export const HISTORY_LIMITED_DETAIL =
  'HISTORY_LIMITED_RECENT_FILE: only the recent window of ' +
  'data.sec.gov/submissions/CIK<cik>.json is ingested; the older filings.files[] shards are not ' +
  'fetched in v1, so filings before ';

export const ITEMS_ONLY_ON_8K_DETAIL =
  'ITEMS_ONLY_ON_8K: item codes exist only on 8-K and 6-K filings; the filter matched nothing in ' +
  'the other selected forms';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fieldIds (§CF L1075)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The tier document's six `FILING_*`/`FA_FILED_AT` ids are not in the dictionary, so this list is
 * empty after the filter — and an empty pre-check set is exactly right for CF: the screen shows no
 * licensed *value*, only the public filing index, and asking about ids no `field_licence` row
 * covers would deny `FIELD_UNKNOWN` and log an audit row that teaches nobody anything (DES.ts §1).
 */
const CF_FIELD_IDS: FieldId[] = [
  'FILING_FORM',
  'FILING_DT',
  'FILING_ACCESSION_NO',
  'FILING_ITEMS',
  'FILING_IS_XBRL',
  'FA_FILED_AT',
].filter((id): id is FieldId => getField(id) !== undefined);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§CF L1103-1105)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const cfCsvColumns: CsvColumn[] = [
  { id: 'accessionNo', label: 'Accession no', type: 'string' },
  { id: 'form', label: 'Form', type: 'string' },
  { id: 'formGroup', label: 'Group', type: 'string' },
  { id: 'filedDate', label: 'Filed', type: 'date' },
  { id: 'acceptedAt', label: 'Accepted', type: 'datetime' },
  { id: 'reportDate', label: 'Period', type: 'date' },
  { id: 'items', label: 'Items', type: 'string' },
  { id: 'itemLabels', label: 'Item labels', type: 'string' },
  { id: 'primaryDoc', label: 'Primary doc', type: 'string' },
  { id: 'primaryDocDesc', label: 'Description', type: 'string' },
  { id: 'isXbrl', label: 'XBRL', type: 'boolean' },
  { id: 'isInlineXbrl', label: 'Inline XBRL', type: 'boolean' },
  { id: 'isAmendment', label: 'Amendment', type: 'boolean' },
  { id: 'amends', label: 'Amends', type: 'string' },
  { id: 'sizeBytes', label: 'Size', type: 'number' },
  { id: 'url', label: 'URL', type: 'string' },
];

/** The page's filings, then the whole window's `formCounts` as `_FORM_COUNT` rows (§1.6 rule 3). */
export function cfCsvRows(payload: CfPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = payload.filings.map((f) => [
    f.accessionNo,
    f.form,
    f.formGroup,
    f.filedDate,
    f.acceptedAt,
    f.reportDate,
    (f.items ?? []).join('|'),
    (f.itemLabels ?? []).join('|'),
    f.primaryDoc,
    f.primaryDocDesc,
    f.isXbrl,
    f.isInlineXbrl,
    f.isAmendment,
    f.amends,
    f.sizeBytes,
    f.url,
  ]);
  for (const c of payload.formCounts) {
    rows.push([
      '_FORM_COUNT',
      c.form,
      c.formGroup,
      c.newest,
      null,
      null,
      '',
      '',
      '',
      null,
      null,
      null,
      null,
      null,
      c.count,
      '',
    ]);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keyboard (§CF L1088-1100)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CF_KEYMAP: readonly KeyBinding[] = [
  { key: 'Enter', action: 'open-filing', when: 'grid', description: 'Open the document on sec.gov' },
  {
    key: 'Shift+Enter',
    action: 'open-fa-next',
    when: 'grid',
    description: 'Open FA as it was known on the filing date',
  },
  ...CfGroups.map((group, i) => ({
    key: String(i + 1),
    action: 'tab-group',
    when: 'always' as const,
    description: `Filter to ${group.toLowerCase()} filings`,
  })),
  { key: 'X', action: 'toggle-xbrl', when: 'always', description: 'XBRL filings only' },
  { key: 'I', action: 'filter-items', when: 'always', description: 'Filter by 8-K item codes' },
  { key: 'Home', action: 'window-back', when: 'grid', description: 'Three more years of history' },
  { key: 'End', action: 'window-now', when: 'grid', description: 'Back to the default window' },
  { key: 'A', action: 'save-alert', when: 'always', description: 'Alert on new filings' },
  { key: 'F', action: 'open-fa', when: 'always', description: 'Open FA (financial analysis)' },
  { key: 'E', action: 'open-ee', when: 'always', description: 'Open EE (earnings)' },
  { key: 'C', action: 'open-cacs', when: 'always', description: 'Open CACS (corporate actions)' },
  { key: 'Delete', action: 'open-cn', when: 'always', description: 'Open CN (company news)' },
  { key: 'PageDown', action: 'page-fwd', when: 'grid', description: 'Older filings' },
  { key: 'PageUp', action: 'page-back', when: 'grid', description: 'Newer filings' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CF = defineFunction<typeof CfParams, CfPayload>({
  code: 'CF',
  name: 'Company Filings',
  aliases: ['FILINGS'],
  tier: 2,
  category: 'fundamentals',
  assetClasses: ['equity', 'etf'],
  requiresSecurity: true,
  variants: { equity: 'issuer', etf: 'issuer' },
  params: CfParams,
  paramGrammar: {
    positional: [{ name: 'group', type: 'enum', values: CfGroups, optional: true }],
    keyed: {
      F: { name: 'forms', type: 'string' },
      I: { name: 'items', type: 'string' },
      FROM: { name: 'from', type: 'date' },
      TO: { name: 'to', type: 'date' },
      X: { name: 'xbrlOnly', type: 'boolean' },
      N: { name: 'limit', type: 'int' },
      KNOWN: { name: 'knownAt', type: 'datetime' },
    },
  },
  fieldIds: (): FieldId[] => [...CF_FIELD_IDS],
  pageable: true,
  // Filings are stored reference data. A new one reaches an open screen on the next run, or
  // through the filing alert the `A` key registers (NEWS-07).
  live: null,
  csv: {
    filename: (_params, ctx): string => {
      const display = (ctx.display ?? 'security').replace(/ /g, '_');
      const asOf = ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      return `CF_${display}_${asOf}.csv`;
    },
    columns: cfCsvColumns,
    rows: (payload): CsvDocument['rows'] => cfCsvRows(payload),
  },
  help: {
    summary: 'SEC filings for this issuer with form, item and XBRL filters',
    description:
      'CF lists the SEC filings of the issuer behind the security on the command line, newest ' +
      'first, with the form, the 8-K items, the period of report and whether the filing carries ' +
      'XBRL. The number keys switch between form groups: periodic (10-K, 10-Q), current (8-K), ' +
      'ownership (Forms 3/4/5, 13D/G), fund (N-PORT, N-CEN) and proxy. Press X for XBRL filings ' +
      'only, I to filter 8-K items, Enter to open the document on sec.gov and Shift+Enter to open ' +
      'FA as it was known on the filing date. Documents are linked, never stored or proxied. ' +
      'Searching inside filing text is not possible in this build: the SEC full-text search ' +
      'endpoint is not reachable, so filter by form, item and date instead.',
    params: [
      { name: 'group', text: 'ALL, PERIODIC, CURRENT, OWNERSHIP, FUND or PROXY', example: 'CF PERIODIC' },
      { name: 'forms', text: 'explicit form types', example: 'F=8-K' },
      { name: 'items', text: '8-K item codes', example: 'I=2.02' },
      { name: 'from', text: 'window start', example: 'FROM=2024-01-01' },
      { name: 'to', text: 'window end', example: 'TO=2026-01-01' },
      { name: 'xbrlOnly', text: 'XBRL filings only', example: 'X=1' },
      { name: 'limit', text: 'rows per page, 10-200', example: 'N=100' },
      { name: 'knownAt', text: 'point-in-time date', example: 'KNOWN=2025-06-30' },
    ],
    keys: CF_KEYMAP.map((k) => ({ key: k.key, action: k.description })),
    sources: ['sec.submissions', 'sec.atom'],
    related: ['FA', 'EE', 'CN', 'CACS', 'DES', 'HDS'],
  },
  keymap: CF_KEYMAP,
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default CF;
