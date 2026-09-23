// packages/core/src/functions/manifests/SECF.ts
//
// SECF — Security Finder (FUNCTIONS_TIER1.md §SECF L2201-2334, FUNCTIONS.md §6 L1089).
//
// SECF is the answer to NO SECURITY LOADED: filtered, faceted, keyset-paged search over the
// security master, ordered by the same match term the command line's autocomplete uses (TERM-02).
//
// Two properties of this manifest are load-bearing:
//
//  1. **`assetClasses: 'none'`.** `AC=` filters the *results*; the function itself takes no
//     security, so the runner ignores `body.security` entirely and `variants` is empty (the payload
//     variant is `'default'`, FUNCTIONS.md §1.3 rule 1).
//  2. **`pageable: true`.** The runner therefore hands every run a `ctx.page`, and the resolver
//     must call `ctx.page.set(...)` — a screen that never reports `meta.page.cursor` can never be
//     paged, because `POST /functions/SECF/page` reads the next cursor out of the cached meta.
//     The cursor encoding is documented on {@link SecfCursor} and asserted by the paging test.

import { z } from 'zod';

import { getField } from '../../fields/dictionary.js';
import type { FieldId } from '../../types/fields.js';
import type { MatchedOn } from '../../search/types.js';
import { defineFunction, type CsvColumn, type CsvDocument, type KeyBinding } from '../manifest.js';
import { AssetClass, MarketSector } from '../schemas.js';
import type { FnInstrumentSummary } from './GP.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§SECF L2213-2227)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SecfParams = z.object({
  query: z.string().max(80).default(''),
  assetClass: AssetClass.optional(),
  sector: MarketSector.optional(),
  exchange: z.string().max(4).optional(),
  country: z.string().length(2).optional(),
  status: z.enum(['active', 'all']).default('active'),
  /** `'SPX'` → only members. */
  indexMember: z.string().max(16).optional(),
  sort: z.enum(['rank', 'ticker', 'name']).default('rank'),
  pageSize: z.number().int().min(20).max(200).default(50),
});
export type SecfParams = z.infer<typeof SecfParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§SECF L2229-2240)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SecfHit {
  instrument: FnInstrumentSummary;
  matchedOn: MatchedOn;
  /** Highlight ranges into `instrument.display`. */
  matched: [number, number][];
  score: number;
  identifiers: { figi: string | null; isin: string | null; cusip: string | null };
  memberOf: string[];
  listings: number;
  gicsSector: string | null;
  /**
   * Index into `meta.provenance` (DATA-10): the OpenFIGI / EDGAR / Yahoo response this row came
   * from, which is what `Ctrl+I` opens on the focused hit (§SECF "Keyboard", `hit-provenance`).
   */
  provIdx: number;
}

export interface SecfPayload {
  variant: 'default';
  hits: SecfHit[];
  total: number;
  facets: {
    assetClass: Record<string, number>;
    exchange: Record<string, number>;
    status: Record<string, number>;
  };
  source: 'master' | 'master+yahoo';
}

/**
 * The keyset cursor, `base64url(JSON.stringify(k))` (§SECF L2257).
 *
 * One shape per sort: `{ s, i }` for `rank` (score descending), `{ t, i }` for `ticker` and
 * `{ n, i }` for `name` (ascending). `i` is always the instrument id, which makes the key total
 * even when two rows share a score or a name — without it a page boundary that falls inside a tie
 * either repeats or skips rows, which is exactly what §SECF's "no duplicates and no gaps" asserts.
 */
export type SecfCursor =
  { s: number; i: number } | { t: string; i: number } | { n: string; i: number };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fieldIds (§SECF L2250)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `[NAME, ID_TICKER, EXCH_CODE, GICS_SECTOR_NAME]`, intersected with the dictionary.
 *
 * Reference fields are not tier-gated, so this pre-check denies nothing for any seeded grant; it
 * exists so that a firm without a reference grant is refused and logged like any other read
 * (ENTL-01, ENTL-05). The tier document spells the ticker `TICKER`; the dictionary's id is
 * `ID_TICKER`, and an id the dictionary does not know resolves to no `field_licence` row and is
 * denied `FIELD_UNKNOWN` — an audit row that teaches nobody anything.
 */
const SECF_FIELD_IDS: FieldId[] = ['NAME', 'ID_TICKER', 'EXCH_CODE', 'GICS_SECTOR_NAME'].filter(
  (id) => getField(id) !== undefined,
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§SECF L2302-2304)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const secfCsvColumns: CsvColumn[] = [
  { id: 'key', label: 'Security', type: 'string' },
  { id: 'name', label: 'Name', type: 'string' },
  { id: 'assetClass', label: 'Asset class', type: 'string' },
  { id: 'securityType', label: 'Security type', type: 'string' },
  { id: 'exchange', label: 'Exchange', type: 'string' },
  { id: 'currency', label: 'Currency', type: 'string' },
  { id: 'figi', label: 'FIGI', type: 'string' },
  { id: 'isin', label: 'ISIN', type: 'string' },
  { id: 'cusip', label: 'CUSIP', type: 'string' },
  { id: 'status', label: 'Status', type: 'string' },
  { id: 'memberOf', label: 'Member of', type: 'string' },
];

/** One row per hit, current page only; `memberOf` is `|`-joined and a null identifier is empty. */
export function secfCsvRows(payload: SecfPayload): CsvDocument['rows'] {
  return payload.hits.map((hit) => [
    hit.instrument.display,
    hit.instrument.name,
    hit.instrument.assetClass,
    hit.instrument.securityType,
    hit.instrument.exchCode,
    hit.instrument.currency,
    hit.identifiers.figi ?? hit.instrument.compositeFigi ?? '',
    hit.identifiers.isin ?? '',
    hit.identifiers.cusip ?? '',
    hit.instrument.status,
    hit.memberOf.join('|'),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keyboard (§SECF L2286-2300)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const AC_TABS: KeyBinding[] = [
  'All',
  'Equity',
  'ETF',
  'Index',
  'Curncy',
  'Govt',
  'Rate/Econ',
  'Crypto',
].map((label, i) => ({
  key: String(i + 1),
  action: 'ac-tab',
  when: 'always' as const,
  description: `Asset-class tab ${label}`,
}));

const SECF_KEYMAP: readonly KeyBinding[] = [
  { key: 'Enter', action: 'open-des', when: 'grid', description: 'Open DES on the focused row' },
  {
    key: 'Shift+Enter',
    action: 'open-des-next',
    when: 'grid',
    description: 'Open DES in the next panel',
  },
  { key: 'Enter', action: 'run-search', when: 'form', description: 'Re-run the search' },
  { key: 'Ctrl+W', action: 'add-watchlist', when: 'grid', description: 'Add to a watchlist' },
  { key: 'X', action: 'exchange-filter', when: 'always', description: 'Filter by exchange' },
  { key: 'S', action: 'toggle-status', when: 'always', description: 'Toggle active / all' },
  { key: 'O', action: 'cycle-sort', when: 'always', description: 'Cycle rank / ticker / name' },
  ...AC_TABS,
  { key: 'PageDown', action: 'page-fwd', when: 'grid', description: 'Next page of hits' },
  { key: 'PageUp', action: 'page-back', when: 'grid', description: 'Previous page of hits' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const SECF = defineFunction<typeof SecfParams, SecfPayload>({
  code: 'SECF',
  name: 'Security Finder',
  aliases: ['SF', 'FIND'],
  tier: 1,
  category: 'reference',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: SecfParams,
  paramGrammar: {
    positional: [],
    keyed: {
      AC: {
        name: 'assetClass',
        type: 'enum',
        values: [
          'equity',
          'etf',
          'index',
          'fx',
          'govt',
          'option',
          'future',
          'crypto',
          'rate',
          'econ',
        ],
      },
      SEC: {
        name: 'sector',
        type: 'enum',
        values: [
          'Equity',
          'Index',
          'Curncy',
          'Govt',
          'Corp',
          'Comdty',
          'Mtge',
          'Muni',
          'Pfd',
          'M-Mkt',
          'Crypto',
        ],
      },
      EXCH: { name: 'exchange', type: 'string' },
      CTRY: { name: 'country', type: 'string' },
      STATUS: { name: 'status', type: 'enum', values: ['active', 'all'] },
      IDX: { name: 'indexMember', type: 'index' },
      SORT: { name: 'sort', type: 'enum', values: ['rank', 'ticker', 'name'] },
      SIZE: { name: 'pageSize', type: 'int' },
    },
    rest: { name: 'query', type: 'text' },
  },
  fieldIds: (): FieldId[] => [...SECF_FIELD_IDS],
  pageable: true,
  // SECF is a reference screen: the results grid registers no live cells and opens no
  // subscription. Prices live in DES and Q, one Enter away.
  live: null,
  csv: {
    filename: (params, ctx): string => {
      const slug = params.query.trim() === '' ? 'all' : params.query.replace(/[^A-Za-z0-9]+/g, '_');
      return `SECF_${slug}_${ctx.asOf.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.csv`;
    },
    columns: secfCsvColumns,
    rows: (payload): CsvDocument['rows'] => secfCsvRows(payload),
  },
  help: {
    summary: 'Filtered, faceted, paged search over the security master',
    description:
      'SECF is the answer to NO SECURITY LOADED and to any ticker the command line could not ' +
      'resolve. It searches the master by ticker prefix, name trigram, issuer alias and by exact ' +
      'ISIN, CUSIP or FIGI, using the same ranking the command line autocomplete uses, then ' +
      'filters by asset class, market sector, exchange, country, status and index membership. ' +
      'The facet counts above the grid are computed over the whole result set, not the visible ' +
      'page, so switching tabs never surprises you. Membership is known only for the S&P 500, ' +
      "whose constituents come from the SPY ETF's N-PORT filing and SSGA's daily holdings file; " +
      'other indices show no membership rather than a guess. When the master has fewer than ' +
      'three hits the Yahoo search endpoint contributes up to eight extra rows, marked as not in ' +
      'the master — Enter on one resolves it through OpenFIGI and creates the master record. ' +
      'Enter opens DES, Shift+Enter opens it in the next panel, PageDown pages further down the ' +
      'ranking.',
    params: [
      { name: 'query', text: 'ticker, name, ISIN, CUSIP or FIGI', example: 'SECF apple' },
      {
        name: 'assetClass',
        text: 'equity, etf, index, fx, govt, option, crypto, rate, econ',
        example: 'AC=ETF',
      },
      { name: 'sector', text: 'market sector', example: 'SEC=Equity' },
      { name: 'exchange', text: 'bbg exchange code, MIC or composite code', example: 'EXCH=UW' },
      { name: 'country', text: 'ISO 2-letter country of issue', example: 'CTRY=US' },
      { name: 'status', text: 'active or all', example: 'STATUS=ALL' },
      { name: 'indexMember', text: 'only members of this index', example: 'IDX=SPX' },
      { name: 'sort', text: 'rank, ticker or name', example: 'SORT=NAME' },
      { name: 'pageSize', text: '20-200 rows per page', example: 'SIZE=100' },
    ],
    keys: SECF_KEYMAP.map((k) => ({ key: k.key, action: k.description })),
    sources: [
      'openfigi.mapping',
      'sec.tickers',
      'cboe.symbolBook',
      'yahoo.search',
      'sec.archives',
      'ssga.holdings',
      'wiki.sp500',
      'internal.derived',
    ],
    related: ['DES', 'QM', 'MEMB', 'W', 'HELP'],
  },
  keymap: SECF_KEYMAP,
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default SECF;
