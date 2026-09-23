// packages/core/src/functions/manifests/N.ts
//
// `N` — News Search (FUNCTIONS_TIER1.md §N L1237-1369, FUNCTIONS.md §6 L1084).
//
// N is the chronological reader over the same corpus TOP ranks: full-text search with the
// stemming and phrase syntax of a web search, filters by feed, topic, kind and date, keyset
// paging **backwards in time** (PAGE FWD shows older headlines), and saved searches that become
// alerts. Two properties are the reason it is a separate function from TOP:
//
//  - **it never re-ranks.** Results are `published_at desc, news_id desc` and nothing else, so a
//    reader paging through a morning's stories sees each one exactly once. TOP is the ranked view;
//    mixing the two would make paging non-deterministic.
//  - **it says how it matched.** `matcher` and the echoed `tsquery` are payload, not decoration:
//    a search that quietly fell back to approximate matching and showed nine near-misses as though
//    they were hits is the failure mode this field exists to prevent.
//
// `assetClasses: 'any'` (§6 binding row: "any (optional security) → default"): a security in the
// panel flips the default scope to that security (TERM-03), and its absence is a degradation with
// a reason, never a 422.

import { z } from 'zod';

import type { NewsKind, NewsRow } from '../shared/news.js';
import { newsCsvColumns, newsCsvRow } from '../shared/news.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import type { AssetClass } from '../../types/instrument.js';
import type { FieldId } from '../../types/fields.js';
import type { TopFeedHealth } from './TOP.js';
import { topAsOfCompact } from './TOP.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§N "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const N_KINDS = ['story', 'video', 'filing', 'press_release', 'fed_release'] as const;

export const NParams = z.object({
  /** `websearch_to_tsquery` syntax: bare words, "phrases", -exclusions, OR. */
  q: z.string().max(200).optional(),
  /** `'security'` pins the query to the panel's loaded instrument (TERM-03). */
  scope: z.enum(['all', 'security']).default('all'),
  feeds: z.array(z.string().max(32)).default([]),
  /** `topics.code`. */
  topics: z.array(z.string().max(32)).default([]),
  kinds: z.array(z.enum(N_KINDS)).default([]),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  pageSize: z.number().int().min(10).max(200).default(50),
  /** Loads `saved_searches.query` and merges it **under** the explicit params. */
  savedSearchId: z.number().int().optional(),
});
export type NParams = z.infer<typeof NParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§N "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The query actually executed, after the saved-search merge. */
export interface NQuery {
  q: string | null;
  instrumentId: number | null;
  instrumentDisplay: string | null;
  feeds: string[];
  topics: string[];
  kinds: NewsKind[];
  from: string | null;
  to: string | null;
}

export interface NPayload {
  variant: 'default';
  query: NQuery;
  /** `'trigram'` = the stemmed query matched nothing and the headline index was used instead. */
  matcher: 'tsquery' | 'trigram' | 'none';
  /** `websearch_to_tsquery(...)::text`, echoed so the user can see what was searched. */
  tsquery: string | null;
  /** `published_at desc, news_id desc` — never re-ranked. */
  rows: NewsRow[];
  /** Capped at 1000 by the resolver; `totalIsCapped` says so. */
  total: number;
  totalIsCapped: boolean;
  nextCursor: string | null;
  savedSearch: { searchId: number; name: string } | null;
  feedHealth: TopFeedHealth[];
  suppressed: { entitlement: number };
  asOf: string;
}

/** STOR-04: the corpus is unbounded, the count is not worth a full scan. */
export const N_TOTAL_CAP = 1000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§N "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Zero or one subject, and `null` for a text query.
 *
 * A text query cannot be evaluated on the wire: the `n:` families are scope subjects, not
 * predicates, so a screen subscribed to one for the query "rate cut" would prepend headlines that
 * do not match it. The honest answer is no subscription and a note on the screen (the resolver
 * records `NO_LIVE_FOR_TEXT_QUERY` in `meta.unavailable`), not a subscription that lies.
 */
function nLive(_params: NParams, payload: NPayload): LiveSpec | null {
  const q = payload.query;
  const subject =
    q.instrumentId !== null
      ? `n:inst:${String(q.instrumentId)}`
      : q.q === null && q.topics.length === 1 && q.feeds.length === 0
        ? `n:topic:${String(q.topics[0])}`
        : q.q === null && q.feeds.length === 1 && q.topics.length === 0
          ? `n:feed:${String(q.feeds[0])}`
          : null;
  if (subject === null) return null;
  return { subjects: [subject], fields: [], essential: [] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§N "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `'tender offer'` → `'tender_offer'`; the query half of the filename (API.md §9). */
export function nQuerySlug(q: string | null): string {
  if (q === null) return 'ALL';
  const slug = q.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug === '' ? 'ALL' : slug.slice(0, 40);
}

export const nCsvColumns: CsvColumn[] = [...newsCsvColumns];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every asset class maps to the one variant.
 *
 * §6's binding row is "any (optional security) → default": N does not change shape with the class
 * of the security in the panel — the security is a *filter* on `news_entity_links`, not a subject
 * the payload is about. The map is exhaustive rather than `{}` so the runner's step-7 assertion
 * has a promise to check whichever security is loaded.
 */
const N_ASSET_CLASSES: readonly AssetClass[] = Object.freeze([
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
]);

export const N = defineFunction<typeof NParams, NPayload>({
  code: 'N',
  name: 'News Search',
  aliases: ['NEWS'],
  tier: 1,
  category: 'news',
  assetClasses: 'any',
  requiresSecurity: false,
  variants: Object.fromEntries(N_ASSET_CLASSES.map((c) => [c, 'default'])),
  params: NParams,
  paramGrammar: {
    positional: [],
    keyed: {
      Q: { name: 'q', type: 'string' },
      SCOPE: { name: 'scope', type: 'enum', values: ['all', 'security'] },
      FEED: { name: 'feeds', type: 'string' },
      TOPIC: { name: 'topics', type: 'topic' },
      KIND: { name: 'kinds', type: 'enum', values: N_KINDS },
      FROM: { name: 'from', type: 'date' },
      TO: { name: 'to', type: 'date' },
      ROWS: { name: 'pageSize', type: 'int' },
      SAVED: { name: 'savedSearchId', type: 'int' },
    },
    /** Everything that is not a `KEY=value` token becomes the query text. */
    rest: { name: 'q', type: 'text' },
  },
  /** Empty for the same reason as TOP: `field_class:'news'` is evaluated per source, not per field. */
  fieldIds: (): FieldId[] => [],
  pageable: true,
  live: nLive,
  csv: {
    filename: (params, ctx): string => {
      const display =
        ctx.display === null ? '' : `${ctx.display.replace(/[^A-Za-z0-9]+/g, '_')}_`;
      return `N_${display}${nQuerySlug(params.q ?? null)}_${topAsOfCompact(ctx.asOf)}.csv`;
    },
    columns: nCsvColumns,
    rows: (payload): (string | number | boolean | null)[][] => payload.rows.map(newsCsvRow),
  },
  help: {
    summary: 'Full-text and filtered search over the normalised news stream',
    description:
      'N searches every headline and summary the platform has captured — Bloomberg RSS, SEC 8-K ' +
      'current filings and Federal Reserve press releases — using Postgres full-text search with ' +
      'the same stemming and phrase syntax as a web search: bare words are ANDed, "quoted ' +
      'phrases" are exact, a leading minus excludes, OR widens. When nothing matches exactly, N ' +
      'falls back to approximate headline matching and says so. Filters narrow by feed, topic, ' +
      'kind of item and date range; typing a security before N pins the search to that ' +
      "security's linked stories. Results are chronological, newest first — TOP is the ranked " +
      'view. Pages move backwards in time: PAGE FWD shows older headlines. A search can be saved ' +
      'and turned into an alert that fires on the next matching headline. Article bodies are not ' +
      'stored; Enter opens the story at the publisher.',
    params: [
      { name: 'q', text: 'search text, websearch syntax', example: '"tender offer" -earnings' },
      { name: 'scope', text: "all or the panel's security", example: 'SCOPE=SECURITY' },
      { name: 'feeds', text: 'feed names, repeatable', example: 'FEED=markets' },
      { name: 'topics', text: 'topic codes, repeatable', example: 'TOPIC=FED' },
      { name: 'kinds', text: 'item kinds, repeatable', example: 'KIND=FILING' },
      { name: 'from', text: 'ISO date, inclusive', example: 'FROM=2026-09-01' },
      { name: 'to', text: 'ISO date, inclusive', example: 'TO=2026-09-15' },
      { name: 'pageSize', text: '10–200 rows', example: 'ROWS=100' },
      { name: 'savedSearchId', text: 'load a saved search', example: 'SAVED=3' },
    ],
    keys: [
      { key: 'Enter', action: 'open the story at the publisher (link-out only)' },
      { key: 'Shift+Enter', action: 'DES on the row’s instrument link, else the story' },
      { key: 'PageDown / PageUp', action: 'older / newer page (PAGE FWD is older)' },
      { key: 'Ctrl+I', action: 'provenance of the focused headline (DATA-10)' },
      { key: '/', action: 'focus the query field' },
      { key: 'R', action: 're-run the search' },
      { key: 'S', action: 'save this search (NEWS-07)' },
      { key: 'A', action: 'alert on this query (NEWS-07)' },
      { key: 'K', action: 'cycle kinds all / stories / filings' },
      { key: 'T', action: 'TOP' },
      { key: 'I', action: 'NI on the first topic' },
    ],
    sources: ['bbg.rss', 'sec.atom', 'fed.rss'],
    related: ['TOP', 'NI', 'CN', 'CF', 'DES'],
  },
  /** The reserved keys (`Enter`, `Shift+Enter`, `PageDown`/`PageUp`, `Ctrl+I`) are in `help.keys`. */
  keymap: [
    { key: '/', action: 'focus-query', description: 'Focus the query field' },
    { key: 'R', action: 'refresh', description: 'Re-run the search (no fn.param row)' },
    { key: 'S', action: 'save-search', description: 'Save this search under a name' },
    { key: 'A', action: 'alert-on-query', description: 'Alert on the next matching headline' },
    { key: 'K', action: 'cycle-kinds', description: 'Cycle kinds all / stories / filings' },
    { key: 'T', action: 'open-top', description: 'The ranked view (TOP)' },
    { key: 'I', action: 'open-ni', description: 'NI on the first topic of the query' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default N;
